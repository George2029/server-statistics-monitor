// Server monitor for the NL VPS. All the logic and looks live in lib/monitor.jsx.
import { makeWidget } from "./lib/monitor.jsx";

const w = makeWidget({ server: "nl_vps", label: "nl", slot: 0 });

export const command = w.command;
export const refreshFrequency = w.refreshFrequency;
export const className = w.className;
export const initialState = w.initialState;
export const updateState = w.updateState;
export const render = w.render;
