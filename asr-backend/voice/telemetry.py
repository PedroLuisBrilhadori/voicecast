"""Standard telemetry for the voice components (OTLP-HTTP -> unidocs collector).

Pattern mirrored from the unidocs API (apps/api/src/core/opentelemetry/tracing.ts):
resource with service.name/host.name, OTLP-HTTP export to the local collector and
graceful degradation — with the collector down nothing breaks, the exports fall
into the BatchProcessor retry/drop.

Env:
  OTEL_ENABLED                  (default: 1) 0 turns all telemetry off
  OTEL_EXPORTER_OTLP_ENDPOINT   (default: http://localhost:4318)
                                              collector publishes 4318 on the host)
  OTEL_SERVICE_NAME             per-caller default (voice-asr / voice-dictate)

Usage (callers don't need to branch — without the SDK the API objects are no-ops):

    from voice import telemetry
    telemetry.init_telemetry("voice-asr")
    tracer = telemetry.tracer()          # safe no-op if disabled
    meter = telemetry.meter()
    counter = meter.create_counter("voice_x_total")

Logs: init attaches an OTLP handler to the root logger (logs go to Loki via
the collector). opentelemetry's own records are filtered (avoids export
error spam/loop).
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
    """Avoids recursion/spam: opentelemetry's own logs don't go to OTLP."""

    def filter(self, record: logging.LogRecord) -> bool:
        return not record.name.startswith("opentelemetry")


def init_telemetry(service_name: str, version: str = "0.3.0") -> bool:
    """Initializes OTLP trace/metrics/logs. Returns True if active.

    Any failure (missing deps, collector down) leaves the caller functional —
    telemetry is best-effort by design.
    """
    global _ENABLED, _INITIALIZED, _SERVICE_NAME, _ENDPOINT
    if _INITIALIZED:
        return _ENABLED
    _INITIALIZED = True
    _SERVICE_NAME = service_name

    if os.environ.get("OTEL_ENABLED", "1").strip().lower() in ("0", "false", "no"):
        log.info("telemetry disabled via OTEL_ENABLED")
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
        log.warning("telemetry deps missing — continuing without OTel", exc_info=True)
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

        # silences the SDK's own retry/drop spam (the BatchProcessor logs
        # "Failed to export" on every interval with the collector down/intermittent —
        # 8% of asr.log was that, hiding real errors). Export failure
        # remains visible via the heartbeat metric, not via a log flood.
        for otel_logger in ("opentelemetry.sdk",
                            "opentelemetry.exporter",
                            "opentelemetry.util._providers"):
            logging.getLogger(otel_logger).setLevel(logging.CRITICAL)

        handler = LoggingHandler(level=logging.INFO, logger_provider=logger_provider)
        handler.addFilter(_OtelLogFilter())
        logging.getLogger().addHandler(handler)

        # OTel's own export errors stay at ERROR (otherwise spam on every retry)
        logging.getLogger("opentelemetry").setLevel(logging.ERROR)

        def _shutdown() -> None:
            for prov in (tracer_provider, meter_provider, logger_provider):
                try:
                    prov.shutdown()
                except Exception:
                    pass

        atexit.register(_shutdown)
        _ENABLED = True
        log.info("telemetry active: service=%s endpoint=%s", service_name, _ENDPOINT)
        return True
    except Exception:
        log.warning("failed to initialize telemetry — continuing without OTel", exc_info=True)
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
    """OTel API tracer — safe no-op if the SDK/deps are not available."""
    try:
        from opentelemetry import trace

        return trace.get_tracer(f"{_SERVICE_NAME}.{name}")
    except Exception:
        return _NullTracer()


def meter(name: str = "voice"):
    """OTel API meter — safe no-op if the SDK/deps are not available."""
    try:
        from opentelemetry import metrics

        return metrics.get_meter(f"{_SERVICE_NAME}.{name}")
    except Exception:
        return _NullMeter()


def log_event(logger: logging.Logger, event: str, **fields: Any) -> None:
    """Structured JSON log — same pattern as the opencode sidecar.

    Why: text logs ("transcribed text (40 chars)") are not queryable
    in Loki; JSON with `event` + fields becomes `| json | event="dictation.ok"`,
    and dashboards and the headless auditor can aggregate by field (model,
    duration, rejection reason). Best-effort: never raises.
    """
    try:
        payload = {"event": event, "host": socket.gethostname(), **fields}
        logger.info(json.dumps(payload, ensure_ascii=False, default=str))
    except Exception:
        pass
