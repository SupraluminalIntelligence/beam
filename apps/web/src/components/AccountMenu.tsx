import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { connectionStatuses } from "../../../../packages/contracts/src/connections";
import { bridge } from "../bridge";
import { useChangelogUnseen } from "../lib/changelog";
import { useLocalRunner } from "../lib/localRunner";
import { PersonAvatar } from "./Avatar";
import type { SettingsTab } from "./Modals";
import { PauseControls, usePause } from "./Notifications";
import type { Me } from "./Shell";
import { useUsageSummary } from "./Usage";

const SHORT: Record<string, string> = { claude: "Claude", codex: "Codex", omp: "omp" };

/**
 * Where my agents can run right now. Desktop: this machine's runner. Browser: any of my machines.
 * `ready` lists harnesses signed in on an online machine; `signIn` those installed but signed out.
 */
function useMachineStatus() {
  const runners = useQuery(api.runners.mine);
  const localId = useLocalRunner();
  const desktop = !!bridge();
  if (runners === undefined) return null;
  const local = runners.find((r) => r.id === localId);
  const online = runners.filter((r) => r.online);
  const scope = local ? [local] : online;
  const statuses = scope.filter((r) => r.online).flatMap((r) => connectionStatuses(r.harnesses));
  const ready = [...new Set(statuses.filter((s) => s.auth === "authenticated").map((s) => s.harness))];
  const signIn = [...new Set(statuses.filter((s) => s.auth === "unauthenticated").map((s) => s.harness))].filter((h) => !ready.includes(h));
  const line = local ? `${local.name} · ${local.online ? "ready for agents" : "offline"}`
    : desktop ? "This machine is starting its runner…"
    : online.length ? `${online.length === 1 ? online[0]!.name : `${online.length} machines`} online`
    : runners.length ? "Your machines are offline" : "No machine connected yet";
  return { online: local ? local.online : online.length > 0, line, ready, signIn };
}

/** The account menu: status at a glance, then shortcuts into Settings pages. */
export function AccountMenu({ me, open, workspaceName, onClose, onSettings, onInvite }: {
  me: Me; open: boolean; workspaceName: string; onClose: () => void; onSettings: (tab?: SettingsTab) => void; onInvite: () => void;
}) {
  const { signOut } = useAuthActions();
  const machine = useMachineStatus();
  const usage = useUsageSummary();
  const paused = usePause() !== null;
  const unseen = useChangelogUnseen();
  const go = (tab?: SettingsTab) => { onClose(); onSettings(tab); };
  const machinesHint = !machine ? "" : machine.signIn.length ? `${machine.signIn.map((h) => SHORT[h] ?? h).join(", ")} needs sign-in`
    : machine.ready.length ? machine.ready.map((h) => `${SHORT[h] ?? h} ✓`).join(" · ") : machine.online ? "no agents signed in" : "";
  return (
    <div className="menu acct-menu" role="menu" hidden={!open}>
      <div className="mh">
        <PersonAvatar login={me.githubLogin} name={me.name} image={me.image} hue="me" />
        <div className="mh-who"><div className="mn">{me.name}</div><div className="k">{me.githubLogin}{me.isAnonymous ? " · guest" : ""}</div></div>
      </div>
      {machine && <button role="menuitem" className="mstatus" onClick={() => go("machines")}><span className={`sq ${machine.online ? "ok" : "idle"}`} /><span className="ml">{machine.line}</span></button>}
      <div className="msep" />
      <button role="menuitem" onClick={() => go("machines")}><span>Machines</span><span className={`k${machine?.signIn.length ? " warn" : ""}`}>{machinesHint}</span></button>
      <button role="menuitem" onClick={() => go("usage")}><span>Usage &amp; limits</span>{usage && <span className={`k lvl-${usage.level}`}>{usage.text}</span>}</button>
      <button role="menuitem" onClick={() => go("models")}><span>Models &amp; accounts</span></button>
      <div className="mrow"><span>{paused ? "Alerts paused" : "Pause alerts"}</span><PauseControls compact onDone={onClose} /></div>
      <div className="msep" />
      <button role="menuitem" onClick={() => { onClose(); onInvite(); }}><span>Invite people</span><span className="k">{workspaceName}</span></button>
      <button role="menuitem" onClick={() => go("workspace")}><span>Workspace settings</span></button>
      <div className="msep" />
      <button role="menuitem" onClick={() => go("whatsnew")}><span>What's new</span>{unseen && <span className="news-dot" aria-label="new" />}</button>
      <button role="menuitem" onClick={() => go()}><span>Settings</span><span className="k">{bridge()?.platform === "darwin" || /Mac/.test(navigator.platform) ? "⌘," : "Ctrl+,"}</span></button>
      <button role="menuitem" className="mout" onClick={() => void signOut()}><span>Log out</span></button>
    </div>
  );
}
