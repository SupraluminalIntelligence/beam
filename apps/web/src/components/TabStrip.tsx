import type { Doc } from "../../../../convex/_generated/dataModel";
import { ui } from "../lib/ui";
import { ICO } from "./Avatar";

export function TabStrip({ wsId, chats, tabs, activeId, onNew }: { wsId: string; chats: Doc<"chats">[]; tabs: string[]; activeId: string | null; onNew: () => void }) {
  return (
    <div className="tabs-strip">
      {tabs.map((id) => {
        const c = chats.find((x) => x._id === id);
        if (!c) return null;
        const on = id === activeId;
        return (
          <div key={id} className={`tab${on ? " on" : ""}`} role="button" tabIndex={0} onClick={() => ui.openChat(wsId, id)} onKeyDown={(e) => { if (e.key === "Enter") ui.openChat(wsId, id); }}>
            <span className="sq idle" />
            {c.private && <span className="lk">{ICO.lock}</span>}
            <span className={`tn${c.untitled ? " untitled" : ""}`}>{c.title}</span>
            <button className="tx" onClick={(e) => { e.stopPropagation(); ui.closeChat(wsId, id); }} title="Close tab (⌘W)">×</button>
          </div>
        );
      })}
      <button className="tab new" onClick={onNew} title="New chat (⌘T) · ⌘⇧T private">+</button>
      <span className="strip-sp" />
      <span className="strip-k">⌘T new chat · ⌘K jump · ⌘W close</span>
    </div>
  );
}
