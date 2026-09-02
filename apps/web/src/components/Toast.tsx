import { useEffect, useState } from "react";

let push: ((t: string) => void) | null = null;
export const toast = (t: string) => push?.(t);

export function Toast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    push = (t) => { setMsg(t); clearTimeout(timer); timer = setTimeout(() => setMsg(null), 2400); };
    return () => { push = null; clearTimeout(timer); };
  }, []);
  return <div className={`toast${msg ? " show" : ""}`}>{msg}</div>;
}
