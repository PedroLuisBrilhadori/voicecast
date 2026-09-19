/**
 * Renderer oculto de captura: getUserMedia(desktop) + mic + MediaRecorder.
 * Mesma malha do PoC da F0 (validada): track +1px, fMP4/avc1+aac nativo.
 * API exposta: window.vcRecord / vcStop / vcCancel / vcPause.
 * O canal de entrega vem via query ?ch=recorder:blob:<startedAt>.
 */
export {};

type VCRec = { ok: boolean; error?: string };

const params = new URLSearchParams(location.search);
const BLOB_CH = params.get("ch") ?? "";

let currentStream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let cancelled = false;
let levelTimer: number | null = null;
let audioCtx: AudioContext | null = null;

const MP4_MIMES = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function pickMime(): string {
  for (const m of MP4_MIMES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {}
  }
  return "";
}

async function blobToB64(b: Blob): Promise<string> {
  // btoa direto nos bytes (dataURL+indexOf quebrava: o mime tem vírgula em
  // codecs="...,..." e o slice comia o início do base64)
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(s);
}

function startMicLevel(stream: MediaStream): void {
  try {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    levelTimer = window.setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      window.vcInternal.micLevel(peak);
    }, 100);
  } catch {}
}

function teardown(): void {
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = null;
  void audioCtx?.close().catch(() => {});
  audioCtx = null;
  currentStream?.getTracks().forEach((t) => t.stop());
  currentStream = null;
}

window.vcRecord = async (opts: { sourceId: string | null; withMic: boolean; mode: string }): Promise<VCRec> => {
  cancelled = false;
  chunks = [];
  try {
    if (!opts.sourceId) return { ok: false, error: "sourceId ausente no recorder" };
    const video = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: opts.sourceId,
          maxFrameRate: 30,
        },
      },
    } as unknown as MediaStreamConstraints);

    let audio: MediaStream | null = null;
    if (opts.withMic) {
      try {
        audio = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {}
    }

    currentStream = new MediaStream([...video.getVideoTracks(), ...(audio ? audio.getAudioTracks() : [])]);
    if (audio) startMicLevel(audio);

    // puxa frames para o compositor (o MediaRecorder precisa disso em janela oculta)
    const v = document.getElementById("v") as HTMLVideoElement;
    v.srcObject = currentStream;
    await v.play().catch(() => {});

    const mime = pickMime();
    console.info(`[recorder] mime=${mime || "(default)"}`);
    recorder = new MediaRecorder(currentStream, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: 6_000_000,
    });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onerror = (e) => console.error("[recorder] error:", String(e));
    recorder.start(1000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
};

window.vcStop = async (): Promise<void> => {
  if (!recorder) return;
  const rec = recorder;
  await new Promise<void>((res) => {
    rec.onstop = () => res();
    try {
      rec.stop();
    } catch {
      res();
    }
  });
  teardown();

  if (cancelled || !BLOB_CH) return; // cancelado: nada entregue
  const mime = rec.mimeType || "video/webm";
  console.info(`[recorder] stop: chunks=${chunks.length} mime=${mime}`);
  const blob = new Blob(chunks, { type: mime });
  const b64 = await blobToB64(blob);
  window.vcInternal.sendBlob(BLOB_CH, { b64, ext: mime.includes("mp4") ? "mp4" : "webm" });
};

window.vcCancel = (): void => {
  cancelled = true;
  try {
    recorder?.stop();
  } catch {}
};

window.vcPause = (p: boolean): void => {
  try {
    if (p) recorder?.pause();
    else recorder?.resume();
  } catch {}
};

declare global {
  interface Window {
    vcRecord: (o: { sourceId: string | null; withMic: boolean; mode: string }) => Promise<VCRec>;
    vcStop: () => Promise<void>;
    vcCancel: () => void;
    vcPause: (p: boolean) => void;
    vcInternal: {
      micLevel: (level: number) => void;
      sendBlob: (ch: string, payload: { b64: string; ext: string }) => void;
      sendRegion: (ch: string, rect: unknown) => void;
    };
  }
}
