"""Telemetria padrão dos componentes de voz (OTLP-HTTP -> collector unidocs).

Padrão espelhado da API do unidocs (apps/api/src/core/opentelemetry/tracing.ts):
resource com service.name/host.name, export OTLP-HTTP para o collector local e
degradação gracosa — com o collector fora do ar nada quebra, os exports caem
no retry/drop do BatchProcessor.

Env:
  OTEL_ENABLED                  (default: 1) 0 desliga toda a telemetria
  OTEL_EXPORTER_OTLP_ENDPOINT   (default: http://localhost:4318)
                                              collector publica 4318 no host)
  OTEL_SERVICE_NAME             default por caller (voice-asr / voice-dictate)

Uso (callers não precisam branch — sem SDK os objetos da API são no-op):

    from voice import telemetry
    telemetry.init_telemetry("voice-asr")
    tracer = telemetry.tracer()          # no-op seguro se desligado
    meter = telemetry.meter()
    counter = meter.create_counter("voice_x_total")

Logs: init anexa um handler OTLP no root logger (logs vão pro Loki via
collector). Registros do próprio opentelemetry são filtrados (evita spam/loop
de erro de export).
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import socket
from typing import Any

log = logging.getLogger("voice-telemetry")

_SERVICE_NAME = "voice"
_ENDPOINT = "http://localhost:4318"
_ENABLED = False
_INITIALIZED = False


def _resource(service_name: str, version: str) -> Any:
    from opentelemetry.sdk.resources import Resource

    return Resource.create(
        {
            "service.name": service_name,
            "service.version": version,
            "service.instance.id": f"{socket.gethostname()}-{os.getpid()}",
            "host.name": os.environ.get("COMPUTERNAME", socket.gethostname()),
            "os.type": "windows",
        }
    )


class _OtelLogFilter(logging.Filter):
    """Evita recursão/spam: logs do próprio opentelemetry não vão pro OTLP."""

    def filter(self, record: logging.LogRecord) -> bool:
        return not record.name.startswith("opentelemetry")


def init_telemetry(service_name: str, version: str = "0.3.0") -> bool:
    """Inicializa trace/métricas/logs OTLP. Retorna True se ativo.

    Qualquer falha (deps ausentes, collector fora) deixa o caller funcional —
    a telemetria é best-effort por design.
    """
    global _ENABLED, _INITIALIZED, _SERVICE_NAME, _ENDPOINT
    if _INITIALIZED:
        return _ENABLED
    _INITIALIZED = True
    _SERVICE_NAME = service_name

    if os.environ.get("OTEL_ENABLED", "1").strip().lower() in ("0", "false", "no"):
        log.info("telemetria desligada via OTEL_ENABLED")
        return False

    _ENDPOINT = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", _ENDPOINT).rstrip("/")

    try:
        from opentelemetry import _logs, metrics, trace
        from opentelemetry.exporter.otlp.proto.http._log_exporter import (
            OTLPLogExporter,
        )
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
            OTLPMetricExporter,
        )
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except Exception:
        log.warning("deps de telemetria ausentes — seguindo sem OTel", exc_info=True)
        return False

    try:
        resource = _resource(service_name, version)

        tracer_provider = TracerProvider(resource=resource)
        tracer_provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{_ENDPOINT}/v1/traces"))
        )
        trace.set_tracer_provider(tracer_provider)

        meter_provider = MeterProvider(
            resource=resource,
            metric_readers=[
                PeriodicExportingMetricReader(
                    OTLPMetricExporter(endpoint=f"{_ENDPOINT}/v1/metrics"),
                    export_interval_millis=15000,
                )
            ],
        )
        metrics.set_meter_provider(meter_provider)

        logger_provider = LoggerProvider(resource=resource)
        logger_provider.add_log_record_processor(
            BatchLogRecordProcessor(OTLPLogExporter(endpoint=f"{_ENDPOINT}/v1/logs"))
        )
        _logs.set_logger_provider(logger_provider)

        # silencia o spam de retry/drop do próprio SDK (BatchProcessor loga
        # "Failed to export" a cada intervalo com collector fora/intermitente —
        # 8% do asr.log era isso, escondendo erros reais). Falha de export
        # continua visível por métrica de heartbeat, não por flood de log.
        for otel_logger in ("opentelemetry.sdk",
                            "opentelemetry.exporter",
                            "opentelemetry.util._providers"):
            logging.getLogger(otel_logger).setLevel(logging.CRITICAL)

        handler = LoggingHandler(level=logging.INFO, logger_provider=logger_provider)
        handler.addFilter(_OtelLogFilter())
        logging.getLogger().addHandler(handler)

        # erros de export do próprio OTel ficam em ERROR (senão spam a cada retry)
        logging.getLogger("opentelemetry").setLevel(logging.ERROR)

        def _shutdown() -> None:
            for prov in (tracer_provider, meter_provider, logger_provider):
                try:
                    prov.shutdown()
                except Exception:
                    pass

        atexit.register(_shutdown)
        _ENABLED = True
        log.info("telemetria ativa: service=%s endpoint=%s", service_name, _ENDPOINT)
        return True
    except Exception:
        log.warning("falha ao inicializar telemetria — seguindo sem OTel", exc_info=True)
        return False


class _NullSpan:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def set_attribute(self, *args, **kwargs):
        pass

    def record_exception(self, *args, **kwargs):
        pass


class _NullTracer:
    def start_as_current_span(self, *args, **kwargs):
        return _NullSpan()


class _NullCounter:
    def add(self, *args, **kwargs):
        pass


class _NullHistogram:
    def record(self, *args, **kwargs):
        pass


class _NullMeter:
    def create_counter(self, *args, **kwargs):
        return _NullCounter()

    def create_histogram(self, *args, **kwargs):
        return _NullHistogram()


def tracer(name: str = "voice"):
    """Tracer da API OTel — no-op seguro se o SDK/deps não estão disponíveis."""
    try:
        from opentelemetry import trace

        return trace.get_tracer(f"{_SERVICE_NAME}.{name}")
    except Exception:
        return _NullTracer()


def meter(name: str = "voice"):
    """Meter da API OTel — no-op seguro se o SDK/deps não estão disponíveis."""
    try:
        from opentelemetry import metrics

        return metrics.get_meter(f"{_SERVICE_NAME}.{name}")
    except Exception:
        return _NullMeter()


def log_event(logger: logging.Logger, event: str, **fields: Any) -> None:
    """Log estruturado JSON — mesmo padrão do sidecar do opencode.

    Por quê: logs de texto ("texto transcrito (40 chars)") não são consultáveis
    no Loki; JSON com `event` + campos vira `| json | event="dictation.ok"`,
    dashboards e o auditor headless conseguem agregar por campo (modelo,
    duração, motivo de rejeição). Best-effort: nunca levanta.
    """
    try:
        payload = {"event": event, "host": socket.gethostname(), **fields}
        logger.info(json.dumps(payload, ensure_ascii=False, default=str))
    except Exception:
        pass
