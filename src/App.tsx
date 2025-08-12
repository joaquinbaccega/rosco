// App.tsx
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ThemeProvider, createTheme, CssBaseline,
  Container, Box, Stack, Typography, Button, IconButton, Chip,
  Card, CardContent, CardActions, Divider, Tooltip, Snackbar, Alert, TextField
} from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import PauseIcon from "@mui/icons-material/Pause";
import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import SkipNextIcon from "@mui/icons-material/SkipNext";
import ScreenShareIcon from "@mui/icons-material/ScreenShare";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { nanoid } from "nanoid";
import { supabase } from "./supabase";

// ---------------- Tipos ----------------
type Rule = "empieza" | "contiene" | "termina";
type Status = "pendiente" | "bien" | "mal" | "pasada";

interface Item { letter: string; rule: Rule; prompt: string; answer: string; }
interface PlayItem extends Item { status: Status }

// ---------------- Tema ----------------
const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#7c4dff" },
    secondary: { main: "#00e5ff" },
    success: { main: "#00e676" },
    error: { main: "#ff5252" },
    warning: { main: "#ffca28" },
    background: { default: "#0f1115", paper: "#151922" },
  },
  shape: { borderRadius: 16 },
  typography: { fontFamily: "Inter, system-ui, -apple-system, Roboto, Arial, sans-serif" },
});

const chipColor: Record<Status, "default" | "success" | "error" | "warning"> = {
  pendiente: "default",
  bien: "success",
  mal: "error",
  pasada: "warning",
};

// ---------------- Fallback preguntas (opcional) ----------------
const FALLBACK_DBZ: Item[] = [];

// ---------------- BroadcastChannel (multi-pestaña local) ----------------
const CHANNEL = "rosco-sync";
let bc: BroadcastChannel | null = null;
if (typeof window !== "undefined" && "BroadcastChannel" in window) {
  bc = new BroadcastChannel(CHANNEL);
}

export default function App(): JSX.Element {
  // Parámetros de URL
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const roleParam = params.get("view");
  const jsonParam = params.get("json");
  const roomFromUrl = params.get("room");

  const [role] = useState<"owner" | "player">(
    roleParam === "player" || roleParam === "owner" ? (roleParam as "owner" | "player") : "owner"
  );
  const [roomId] = useState<string>(() => roomFromUrl || nanoid(6));

  // Fullscreen
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [isFs, setIsFs] = useState(false);
  useEffect(() => {
    const onFsChange = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  function toggleFullscreen() {
    const el = cardRef.current ?? document.documentElement;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  // Helpers de tiempo
  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
  const formatSeconds = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const parseMmSs = (str: string): number | null => {
    const m = String(str).trim();
    if (!m) return null;
    const parts = m.split(":");
    if (parts.length === 1) {
      const n = Number(parts[0]);
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    const min = Number(parts[0]);
    const sec = Number(parts[1]);
    if (Number.isFinite(min) && Number.isFinite(sec) && sec >= 0 && sec < 60) {
      return Math.round(min * 60 + sec);
    }
    return null;
  };

  // Estado base
  const [items, setItems] = useState<PlayItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [snack, setSnack] = useState<string | undefined>();

  const [defaultSeconds, setDefaultSeconds] = useState<number>(() => {
    if (typeof window === "undefined") return 180;
    const raw = Number(localStorage.getItem("rosco-default-seconds") || "180");
    return Number.isFinite(raw) ? raw : 180;
  });
  const [timerInput, setTimerInput] = useState<string>(formatSeconds(defaultSeconds));
  const [seconds, setSeconds] = useState<number>(defaultSeconds);

  const [customUrl, setCustomUrl] = useState<string>(() => {
    if (typeof window === "undefined") return "/questions.json";
    return localStorage.getItem("rosco-url") || "/questions.json";
  });

  useEffect(() => { setTimerInput(formatSeconds(seconds)); }, [seconds]);

  // Cargar por URL (opcional, via proxy /api/fetch-json)
  async function loadFromUrl(url: string, silent = false) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Item[] = await res.json();

      const mapped: PlayItem[] = (Array.isArray(data) ? data : [])
        .filter((d: any) => d && d.letter && d.rule && d.prompt && d.answer)
        .map((d: any) => ({
          letter: String(d.letter).toUpperCase(),
          rule: (["empieza", "contiene", "termina"] as Rule[]).includes(d.rule) ? d.rule : "empieza",
          prompt: String(d.prompt),
          answer: String(d.answer),
          status: "pendiente",
        }));

      if (!mapped.length) throw new Error("El JSON está vacío o mal formateado");

      setItems(mapped);
      setIdx(0);
      setFinished(false);
      setRunning(false);
      setSeconds(defaultSeconds);

      if (!silent) setSnack("Banco cargado ✅");
      try { localStorage.setItem("rosco-url", url); } catch { /* noop */ }
    } catch (e: any) {
      setItems(FALLBACK_DBZ.map(i => ({ ...i, letter: i.letter.toUpperCase(), status: "pendiente" })));
      setIdx(0);
      setFinished(false);
      setRunning(false);
      setSeconds(defaultSeconds);
      setSnack(`No se pudo cargar el JSON (${e?.message ?? e}).`);
    }
  }

  // Cargar por archivo local (botón "Cargar JSON")
  async function loadFromFile(file: File) {
    try {
      const text = await file.text();
      const data: Item[] = JSON.parse(text);

      const mapped: PlayItem[] = (Array.isArray(data) ? data : [])
        .filter((d: any) => d && d.letter && d.rule && d.prompt && d.answer)
        .map((d: any) => ({
          letter: String(d.letter).toUpperCase(),
          rule: (["empieza", "contiene", "termina"] as Rule[]).includes(d.rule) ? d.rule : "empieza",
          prompt: String(d.prompt),
          answer: String(d.answer),
          status: "pendiente",
        }));

      if (!mapped.length) throw new Error("El JSON está vacío o mal formateado");

      setItems(mapped);
      setIdx(0);
      setFinished(false);
      setRunning(false);
      setSeconds(defaultSeconds);
      setSnack(`Banco cargado desde archivo ✅ (${file.name})`);
    } catch (e: any) {
      setSnack(`No se pudo leer el archivo: ${e?.message ?? e}`);
    }
  }

  // Carga inicial (owner): si viene ?json, lo usa
  useEffect(() => {
    if (role !== "owner") return;
    const jsonParam = new URLSearchParams(window.location.search).get("json");
    if (jsonParam) {
      const initialUrl = decodeURIComponent(jsonParam);
      const finalUrl = initialUrl.startsWith("/api/")
        ? initialUrl
        : `/api/fetch-json?url=${encodeURIComponent(initialUrl)}`;
      loadFromUrl(finalUrl, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  // Timer (owner)
  useEffect(() => {
    if (role !== "owner" || !running || finished) return;
    const t = setInterval(() => setSeconds(s => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [running, finished, role]);

  useEffect(() => {
    if (seconds === 0 && running && role === "owner") {
      setRunning(false);
      setFinished(true);
      broadcastAll();
    }
  }, [seconds, running, role]);

  // ---------- Realtime: canal único por room ----------
  const roomChannelRef = useRef<RealtimeChannel | null>(null);
  const [joined, setJoined] = useState(false);

  // Suscripción realtime (owner + player) — se crea una vez por room
  useEffect(() => {
    if (!supabase) return;

    const channel = supabase
      .channel(roomId, { config: { broadcast: { ack: true } } })
      .on("broadcast", { event: "state" }, (msg: any) => {
        const m = msg.payload;
        if (!m) return;
        // Solo el player aplica el estado (el dueño es la fuente)
        if (role === "player") {
          setItems(m.items);
          setIdx(m.idx);
          setSeconds(m.seconds);
          setRunning(m.running);
          setFinished(m.finished);
        }
      });

    roomChannelRef.current = channel;
    setJoined(false);

    channel.subscribe((status) => {
      // 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR'
      if (status === "SUBSCRIBED") setJoined(true);
    });

    return () => {
      setJoined(false);
      roomChannelRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [roomId, role]);

  // Broadcast local (multi-pestaña)
  function broadcastLocal() {
    const payload = { type: "state", items, idx, seconds, running, finished, roomId };
    bc?.postMessage(payload);
    try { localStorage.setItem("rosco-sync", JSON.stringify({ ...payload, ts: Date.now() })); } catch { /* noop */ }
  }

  // Broadcast realtime (una vez unido al canal)
  const lastSentRef = useRef<number>(0);
  async function broadcastRealtime() {
    if (!roomChannelRef.current || !joined) return;
    const now = performance.now();
    if (now - lastSentRef.current < 120) return; // throttle ~8 msg/s
    lastSentRef.current = now;

    await roomChannelRef.current.send({
      type: "broadcast",
      event: "state",
      payload: { items, idx, seconds, running, finished }
    });
  }

  function broadcastAll() {
    if (role !== "owner") return;
    broadcastLocal();
    broadcastRealtime();
  }

  // Emitir cambios de estado (solo dueño y si canal está unido)
  useEffect(() => {
    if (role === "owner" && joined) broadcastAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, idx, seconds, running, finished, joined, role]);

  // Suscripción local (player)
  useEffect(() => {
    if (role !== "player") return;
    const onMsg = (e: MessageEvent) => {
      const m = e.data;
      if (!m || m.type !== "state") return;
      if (m.roomId && m.roomId !== roomId) return;
      setItems(m.items);
      setIdx(m.idx);
      setSeconds(m.seconds);
      setRunning(m.running);
      setFinished(m.finished);
    };
    bc?.addEventListener("message", onMsg);

    const onStorage = (e: StorageEvent) => {
      if (e.key === "rosco-sync" && e.newValue) {
        try {
          const m = JSON.parse(e.newValue);
          if (m.type === "state" && (!m.roomId || m.roomId === roomId)) {
            setItems(m.items);
            setIdx(m.idx);
            setSeconds(m.seconds);
            setRunning(m.running);
            setFinished(m.finished);
          }
        } catch { /* noop */ }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      bc?.removeEventListener("message", onMsg);
      window.removeEventListener("storage", onStorage);
    };
  }, [role, roomId]);

  // Lógica de juego
  const score = useMemo(() => items.filter(i => i.status === "bien").length, [items]);
  const wrong = useMemo(() => items.filter(i => i.status === "mal").length, [items]);

  function nextIndex(from = idx) {
    if (!items.length) return 0;
    let j = (from + 1) % items.length;
    for (let c = 0; c < items.length; c++) {
      if (items[j].status === "pendiente" || items[j].status === "pasada") return j;
      j = (j + 1) % items.length;
    }
    return from;
  }

  function mark(status: Status) {
    if (role !== "owner" || finished || !items.length) return;
    const cur = items[idx];
    const updated = [...items];
    updated[idx] = { ...cur, status };
    setItems(updated);
    setIdx(nextIndex(idx));
  }

  function start() { if (role === "owner") { setRunning(true); setFinished(false); } }
  function pause() { if (role === "owner") setRunning(false); }
  function reset() {
    if (role !== "owner") return;
    setItems(arr => arr.map(x => ({ ...x, status: "pendiente" as Status })));
    setIdx(0); setSeconds(defaultSeconds); setFinished(false); setRunning(false);
  }

  function setTimer(newSeconds: number) {
    if (role !== "owner") return;
    setSeconds(clamp(newSeconds, 0, 60 * 60));
  }
  function adjustTimer(delta: number) { setTimer(seconds + delta); }
  function applyTimerInput() {
    const parsed = parseMmSs(timerInput);
    if (parsed == null) { setSnack("Formato inválido. Usá mm:ss o solo segundos."); return; }
    setTimer(parsed);
    setDefaultSeconds(parsed);
    try { localStorage.setItem("rosco-default-seconds", String(parsed)); } catch { /* noop */ }
  }

  function openPlayer() {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "player");
    url.searchParams.set("room", roomId);
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }
  function copyPlayerLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "player");
    url.searchParams.set("room", roomId);
    navigator.clipboard.writeText(url.toString());
    setSnack("Link de participante copiado");
  }

  // UI
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container
        maxWidth="md"
        sx={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          py: role === "player" ? 1 : 4,
        }}
      >
        <Card ref={cardRef} sx={{ width: "100%", maxWidth: 900, position: "relative" }}>
          <CardContent sx={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 2 }}>
            {/* Cabecera: solo dueño */}
            {role === "owner" && (
              <>
                <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "center" }} spacing={2}>
                  <Typography variant="h5">Rosco — Dueño</Typography>
                  <Stack direction="row" spacing={1}>
                    <Button size="small" variant="outlined" startIcon={<ScreenShareIcon />} onClick={openPlayer}>
                      Abrir vista participante
                    </Button>
                    <Tooltip title="Copiar link de participante">
                      <IconButton onClick={copyPlayerLink}><ContentCopyIcon /></IconButton>
                    </Tooltip>
                  </Stack>
                </Stack>
                <Divider />
              </>
            )}

            {/* Barra de info */}
            <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "center" }} spacing={2}>
              {role === "owner"
                ? <Typography>Puntos: <b>{score}</b> · Errores: <b>{wrong}</b> · Sala: <b>{roomId}</b></Typography>
                : <Typography>Tiempo: <b>{formatSeconds(seconds)}</b> · Sala: <b>{roomId}</b></Typography>
              }

              {role === "owner" && (
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                  <TextField
                    size="small"
                    label="Tiempo (mm:ss)"
                    value={timerInput}
                    onChange={(e) => setTimerInput(e.target.value)}
                    onBlur={applyTimerInput}
                    onKeyDown={(e) => { if (e.key === "Enter") applyTimerInput(); }}
                    sx={{ width: 160 }}
                    helperText="Enter para aplicar"
                  />
                  <Button size="small" variant="outlined" onClick={() => adjustTimer(-10)}>-10s</Button>
                  <Button size="small" variant="outlined" onClick={() => adjustTimer(10)}>+10s</Button>
                  <Button size="small" variant="outlined" onClick={() => adjustTimer(60)}>+1m</Button>
                </Stack>
              )}
            </Stack>

            {/* Rosco */}
            <Box sx={{ display: "grid", placeItems: "center", py: role === "player" ? 1 : 2 }}>
              <Box
                sx={{
                  position: "relative",
                  width: 460,
                  height: 460,
                  borderRadius: "50%",
                  mx: "auto",
                  my: 1,
                  background: "radial-gradient(circle, rgba(255,255,255,0.05) 72%, transparent 73%)",
                }}
              >
                {items.map((it, i) => {
                  const total = items.length || 1;
                  const angle = (i / total) * 2 * Math.PI - Math.PI / 2; // A arriba
                  const radius = 200; // separación
                  const x = radius * Math.cos(angle);
                  const y = radius * Math.sin(angle);
                  return (
                    <Chip
                      key={i}
                      label={it.letter}
                      color={chipColor[it.status]}
                      variant={i === idx ? "filled" : "outlined"}
                      sx={{
                        position: "absolute",
                        left: `calc(50% + ${x}px - 20px)`,
                        top: `calc(50% + ${y}px - 20px)`,
                        fontWeight: 700,
                        minWidth: 40,
                      }}
                    />
                  );
                })}
              </Box>
            </Box>

            {/* Pregunta / Respuesta */}
            <Box sx={{ textAlign: "center", my: 1, px: 2 }}>
              <Typography variant="overline" color="text.secondary">
                {(items[idx]?.rule || "").toUpperCase()}
              </Typography>
              <Typography variant="h4" sx={{ my: 1, wordBreak: "break-word" }}>
                <b>{items[idx]?.letter}</b> — {items[idx]?.prompt}
              </Typography>
              {role === "owner" && (
                <Typography variant="subtitle1" color="success.main" sx={{ mt: 1, wordBreak: "break-word" }}>
                  Respuesta: <b>{items[idx]?.answer}</b>
                </Typography>
              )}
            </Box>

            {/* Controles: solo dueño */}
            {role === "owner" && (
              <Stack direction="row" spacing={2} justifyContent="center" sx={{ mt: 1, flexWrap: "wrap" }}>
                {!running && !finished && <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={start}>Empezar</Button>}
                {running && <Button variant="outlined" startIcon={<PauseIcon />} onClick={pause}>Pausar</Button>}
                <Button variant="outlined" startIcon={<RestartAltIcon />} onClick={reset}>Reiniciar</Button>
                <Button color="warning" variant="outlined" startIcon={<SkipNextIcon />} onClick={() => mark("pasada")}>Pasapalabra</Button>
                <Button color="success" variant="contained" startIcon={<CheckIcon />} onClick={() => mark("bien")}>Bien</Button>
                <Button color="error" variant="contained" startIcon={<CloseIcon />} onClick={() => mark("mal")}>Mal</Button>
              </Stack>
            )}

            {/* Cargar banco (archivo local + opcional URL) solo dueño */}
            {role === "owner" && (
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems="center" sx={{ mt: 2, justifyContent: "center" }}>
                {/* Cargar por archivo (recomendado) */}
                <Button variant="contained" component="label">
                  Cargar JSON
                  <input
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(e) => {
                      const f = (e.target as HTMLInputElement).files?.[0];
                      if (f) loadFromFile(f);
                      (e.currentTarget as HTMLInputElement).value = "";
                    }}
                  />
                </Button>

                {/* (Opcional) Cargar por URL vía proxy /api/fetch-json */}
                <TextField
                  size="small"
                  label="URL del JSON (opcional)"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="/questions.json"
                  sx={{ minWidth: 320 }}
                />
                <Button variant="text" onClick={() => loadFromUrl(`/api/fetch-json?url=${encodeURIComponent(customUrl)}`)}>
                  Cargar desde URL
                </Button>
              </Stack>
            )}

            {finished && (
              <Box sx={{ mt: 2, textAlign: "center" }}>
                <Typography variant="h6">Resultado</Typography>
                <Typography>
                  ✔️ Correctas: {score} · ❌ Incorrectas: {wrong} · 🔁 Pasadas: {items.filter(i => i.status === "pasada").length}
                </Typography>
                <Divider sx={{ my: 2 }} />
                <Stack spacing={0.5}>
                  {items.map((it, i) => (
                    <Typography key={i} variant="body2">[{it.letter}] {it.prompt} — <b>{it.answer}</b></Typography>
                  ))}
                </Stack>
              </Box>
            )}
          </CardContent>

          {role === "owner" && (
            <CardActions sx={{ justifyContent: "center", pb: 3 }}>
              <Typography variant="caption" color="text.secondary">
                Abrí otra pestaña como participante con el botón arriba o usando <code>?view=player&amp;room={roomId}</code> en la URL.
              </Typography>
            </CardActions>
          )}

          {role === "player" && (
            <IconButton
              onClick={toggleFullscreen}
              sx={{
                position: "fixed",
                right: 16,
                bottom: 16,
                zIndex: 10,
                bgcolor: "background.paper",
                boxShadow: 3,
                "&:hover": { bgcolor: "background.default" },
              }}
              aria-label="Pantalla completa"
              size="large"
            >
              {isFs ? <FullscreenExitIcon /> : <FullscreenIcon />}
            </IconButton>
          )}
        </Card>
      </Container>

      <Snackbar open={!!snack} autoHideDuration={3500} onClose={() => setSnack(undefined)}>
        <Alert severity="info" variant="filled" onClose={() => setSnack(undefined)}>{snack}</Alert>
      </Snackbar>
    </ThemeProvider>
  );
}
