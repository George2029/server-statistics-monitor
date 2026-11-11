// Shared server-monitor widget. Every server widget (../nl.jsx, ../ru.jsx, …)
// is a few lines that call makeWidget() with its own settings, so any change
// made here applies to all of them.
//
// Übersicht does not treat files inside a lib/ folder as widgets, so this
// file is only ever used through those imports.
//
// Move a card: drag it by its header. Double-click the header to reset the
// position. Each card remembers its own position between restarts.

import { React } from "uebersicht";

const { useState, useEffect, useRef } = React;

const PROJECT = "/Users/george/projects/widgets/remote_servers_usage";

const REFRESH_MS = 10000;                // ms between polls
const HISTORY = 60;                      // samples kept for the graphs (60 × ~10 s ≈ 10 min)
const STALE_MS = 35000;                  // no fresh data for this long → "offline"
const CARD_WIDTH = 290;
const CARD_GAP = 372;                    // vertical distance between default positions (card ≈ 354 px + gap)

// green → amber → red by thresholds
const level = (v, warn, crit) => (v >= crit ? "crit" : v >= warn ? "warn" : "ok");
const COLORS = { ok: "#4ade80", warn: "#fbbf24", crit: "#f87171" };

// ----------------------------------------------------------------- formatting

const fmtBytes = (b) => {
  if (b == null) return "–";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
  return `${b.toFixed(b < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

const fmtUptime = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
};

const fmtAgo = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

// ----------------------------------------------------------------- styles

const className = `
  top: 0;
  left: 0;
  font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.92);
  -webkit-font-smoothing: antialiased;

  .card {
    position: fixed;
    width: ${CARD_WIDTH}px;
    box-sizing: border-box;
    padding: 14px 16px 12px;
    /* Nearly opaque, and no backdrop blur: the blur gets recomputed on every
       redraw, which made the card's transparency flicker between refreshes. */
    background: rgba(22, 24, 30, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.10);
    border-radius: 16px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  }
  .card.dragging { box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4); }

  .header {
    display: flex; align-items: center; gap: 8px;
    margin: -14px -16px 10px; padding: 12px 16px 6px;
    cursor: grab; user-select: none;
  }
  .dragging .header { cursor: grabbing; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .host { font-size: 13px; font-weight: 600; letter-spacing: 0.2px; }
  .status { margin-left: auto; font-size: 11px; color: rgba(255,255,255,0.45); }

  .metric { margin-bottom: 12px; }
  .row { display: flex; align-items: baseline; justify-content: space-between; }
  .label {
    font-size: 11px; font-weight: 600; letter-spacing: 0.8px;
    text-transform: uppercase; color: rgba(255,255,255,0.55);
  }
  .value { font-size: 26px; font-weight: 600; line-height: 1.1; }
  .value small { font-size: 14px; font-weight: 500; opacity: 0.7; margin-left: 1px; }
  .sub { font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 2px; }

  .bar {
    position: relative; height: 4px; margin-top: 6px;
    background: rgba(255,255,255,0.10); border-radius: 2px; overflow: hidden;
  }
  .bar > div { position: absolute; inset: 0 auto 0 0; border-radius: 2px; transition: width 0.6s ease; }
  .spark { display: block; margin-top: 6px; }

  .footer {
    border-top: 1px solid rgba(255,255,255,0.08);
    padding-top: 8px; margin-top: 2px;
    font-size: 11px; line-height: 1.6; color: rgba(255,255,255,0.55);
  }
  .footer b { font-weight: 500; color: rgba(255,255,255,0.8); }
  .error { font-size: 11px; color: ${COLORS.crit}; margin-top: 4px; word-break: break-word; }
`;

// ----------------------------------------------------------------- pieces

const Bar = ({ pct, color }) => (
  <div className="bar">
    <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
  </div>
);

// Small line graph of the recent samples (0–100 %).
const Spark = ({ values, color }) => {
  const w = CARD_WIDTH - 32, h = 22;
  if (values.length < 2) return <svg className="spark" width={w} height={h} />;
  const step = w / (values.length - 1);                 // spread whatever history we have over the full width
  const pts = values.map((v, i) => [i * step, h - 1 - (Math.min(v, 100) / 100) * (h - 2)]);
  const line = pts.map((p) => p.join(",")).join(" ");
  const area = `${pts[0][0]},${h} ${line} ${pts[pts.length - 1][0]},${h}`;
  return (
    <svg className="spark" width={w} height={h}>
      <polygon points={area} fill={color} opacity="0.15" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
};

// ----------------------------------------------------------------- dragging

const clamp = ({ x, y }) => ({
  x: Math.min(Math.max(0, x), window.innerWidth - 60),
  y: Math.min(Math.max(0, y), window.innerHeight - 40),
});

// Card that can be dragged by its header. `posKey` is where its position is
// saved; `slot` picks a default spot so several cards don't start on top of
// each other (slot 0 top-right, slot 1 below it, …).
const Draggable = ({ children, header, posKey, slot }) => {
  const defaultPos = () => ({
    x: Math.max(16, window.innerWidth - CARD_WIDTH - 32),
    y: 48 + slot * CARD_GAP,
  });
  const loadPos = () => {
    try {
      const p = JSON.parse(localStorage.getItem(posKey));
      if (p && typeof p.x === "number" && typeof p.y === "number") return clamp(p);
    } catch (e) {}
    return defaultPos();
  };
  const savePos = (p) => { try { localStorage.setItem(posKey, JSON.stringify(p)); } catch (e) {} };

  const [pos, setPos] = useState(loadPos);
  const [dragging, setDragging] = useState(false);
  const offset = useRef(null);
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    if (!dragging) return;
    const stop = () => { setDragging(false); savePos(posRef.current); };
    const move = (e) => {
      if (e.buttons === 0) return stop();            // button released outside the widget
      setPos(clamp({ x: e.clientX - offset.current.x, y: e.clientY - offset.current.y }));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
  }, [dragging]);

  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    setDragging(true);
  };

  const onDoubleClick = () => { const p = defaultPos(); setPos(p); savePos(p); };

  return (
    <div className={`card${dragging ? " dragging" : ""}`} style={{ left: pos.x, top: pos.y }}>
      <div className="header" onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}
           title="Drag to move · double-click to reset">
        {header}
      </div>
      {children}
    </div>
  );
};

// ----------------------------------------------------------------- the widget

// server: folder in the project with that server's server.sh (e.g. "nl_vps")
// label:  name shown before the first reading arrives (later: the hostname)
// slot:   default position, 0 = top-right, 1 = below it, …
export const makeWidget = ({ server, label = server, slot = 0 }) => {
  const posKey = `server-monitor:pos:${server}`;

  // Übersicht calls updateState after every command run. We keep the latest
  // data plus a short history of CPU and RAM for the little graphs.
  const initialState = { data: null, error: null, lastOk: 0, history: [] };

  const updateState = (event, prev) => {
    if (event.type !== "UB/COMMAND_RAN") return prev;
    if (event.error) return { ...prev, error: String(event.error) };
    try {
      const data = JSON.parse(event.output);
      const sample = { cpu: data.cpu.usage_pct, ram: data.ram.used_pct };
      return {
        data,
        error: null,
        lastOk: Date.now(),
        history: [...prev.history, sample].slice(-HISTORY),
      };
    } catch (e) {
      const msg = (event.output || "").trim().split("\n").pop() || "no output";
      return { ...prev, error: msg };
    }
  };

  const render = ({ data, error, lastOk, history }) => {
    const stale = !lastOk || Date.now() - lastOk > STALE_MS;
    const dot = !data ? "rgba(255,255,255,0.3)" : stale || error ? COLORS.crit : COLORS.ok;
    const status = !data
      ? (error ? "offline" : "connecting…")
      : stale ? `offline · seen ${fmtAgo(Date.now() - lastOk)}` : "live";

    const header = (
      <>
        <span className="dot" style={{ background: dot }} />
        <span className="host">{data ? data.host : label}</span>
        <span className="status">{status}</span>
      </>
    );

    if (!data) {
      return (
        <Draggable header={header} posKey={posKey} slot={slot}>
          <div className="sub">Waiting for the first reading…</div>
          {error && <div className="error">{error}</div>}
        </Draggable>
      );
    }

    const { cpu, ram, net, uptime_seconds, disks } = data;
    const cpuColor = COLORS[level(cpu.usage_pct, 70, 90)];
    const ramColor = COLORS[level(ram.used_pct, 75, 90)];
    const loadPerCore = cpu.load[0] / cpu.cores;
    const loadColor = COLORS[level(loadPerCore, 1, 2)];
    const root = (disks || []).find((d) => d.mount === "/") || (disks || [])[0];

    return (
      <Draggable header={header} posKey={posKey} slot={slot}>
        {/* CPU */}
        <div className="metric">
          <div className="row">
            <span className="label">CPU</span>
            <span className="value" style={{ color: cpuColor }}>
              {cpu.usage_pct.toFixed(1)}<small>%</small>
            </span>
          </div>
          <Spark values={history.map((s) => s.cpu)} color={cpuColor} />
          <div className="sub">
            {cpu.cores} {cpu.cores === 1 ? "core" : "cores"} · iowait {cpu.iowait_pct.toFixed(1)}% · steal {cpu.steal_pct.toFixed(1)}%
          </div>
        </div>

        {/* RAM */}
        <div className="metric">
          <div className="row">
            <span className="label">RAM</span>
            <span className="value" style={{ color: ramColor }}>
              {ram.used_pct.toFixed(1)}<small>%</small>
            </span>
          </div>
          <Spark values={history.map((s) => s.ram)} color={ramColor} />
          <div className="sub">
            {fmtBytes(ram.used_bytes)} of {fmtBytes(ram.total_bytes)}
            {ram.swap_total_bytes > 0 && ` · swap ${fmtBytes(ram.swap_used_bytes)}`}
          </div>
        </div>

        {/* LOAD */}
        <div className="metric">
          <div className="row">
            <span className="label">Load</span>
            <span className="value" style={{ color: loadColor }}>
              {cpu.load[0].toFixed(2)}
            </span>
          </div>
          <Bar pct={(loadPerCore / 2) * 100} color={loadColor} />
          <div className="sub">
            1 min avg · 5 min {cpu.load[1].toFixed(2)} · 15 min {cpu.load[2].toFixed(2)}
            {cpu.cores > 1 && ` · ${loadPerCore.toFixed(2)} per core`}
          </div>
        </div>

        {/* small info */}
        <div className="footer">
          {net.interface ? (
            <>
              <div>net now <b>↓ {fmtBytes(net.rx_bytes_per_s)}/s</b> · <b>↑ {fmtBytes(net.tx_bytes_per_s)}/s</b></div>
              <div>since boot ↓ {fmtBytes(net.rx_total_bytes)} · ↑ {fmtBytes(net.tx_total_bytes)}</div>
            </>
          ) : (
            <div>net n/a</div>
          )}
          <div>
            up <b>{fmtUptime(uptime_seconds)}</b>
            {root && <> · disk <b>{root.used_pct.toFixed(0)}%</b> of {fmtBytes(root.total_bytes)}</>}
          </div>
          {error && <div className="error">last poll failed: {error}</div>}
        </div>
      </Draggable>
    );
  };

  return {
    command: `${PROJECT}/run.sh ${server}`,
    refreshFrequency: REFRESH_MS,
    className,
    initialState,
    updateState,
    render,
  };
};
