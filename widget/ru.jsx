// Server monitor for the RU VM. All the logic and looks live in lib/monitor.jsx.
import { makeWidget } from "./lib/monitor.jsx";

const w = makeWidget({ server: "ru_vps", label: "ru", slot: 1 });

export const command = w.command;
export const refreshFrequency = w.refreshFrequency;
export const className = w.className;
export const initialState = w.initialState;
export const updateState = w.updateState;
export const render = w.render;
