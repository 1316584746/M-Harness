import { useState } from "react";
import type { AskRequest } from "../../../shared/api";
import { Icon } from "./Icon";

type Answers = Array<{ id: string; picked: string[]; text?: string }>;

/** AI 运行中向操作人提的问题：每个问题给几个选项（A / B / C…），也可以「自定义回答」；全部答完提交，或者「稍后再补充」让 AI 先自己做合理假设 */
export function AskForm({ req, onSubmit }: { req: AskRequest; onSubmit: (answers: Answers | null) => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [text, setText] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const toggle = (id: string, opt: string, multiple: boolean) =>
    setPicked(p => {
      const cur = p[id] ?? [];
      const has = cur.includes(opt);
      return { ...p, [id]: multiple ? (has ? cur.filter(x => x !== opt) : [...cur, opt]) : has ? [] : [opt] };
    });
  const filled = (id: string) => (picked[id]?.length ?? 0) > 0 || !!text[id]?.trim();
  const done = req.questions.filter(q => filled(q.id)).length;
  const ready = done === req.questions.length;

  const submit = (later: boolean) => {
    if (busy) return;
    setBusy(true);
    onSubmit(later ? null : req.questions.map(q => ({ id: q.id, picked: picked[q.id] ?? [], ...(text[q.id]?.trim() ? { text: text[q.id].trim() } : {}) })));
  };

  return (
    <div className="ask-card" data-testid="ask-card" role="group" aria-label="AI 向你提问">
      <div className="ask-head">
        <Icon name="spark" size={15} />
        <b>AI 想跟你确认 {req.questions.length} 个问题</b>
      </div>
      {req.questions.map((q, i) => {
        const hasOpts = !!q.options?.length;
        const showText = q.allowText !== false && (!hasOpts || custom[q.id] || !!text[q.id]);
        return (
          <div className="ask-q" key={q.id} data-testid="ask-q">
            <div className="ask-qtext">
              <span className="ask-qn">Q{i + 1}</span>
              <span>
                {q.question}
                {q.multiple && <span className="muted"> （可多选）</span>}
              </span>
            </div>
            {hasOpts && (
              <div className="ask-opts">
                {q.options!.map((o, k) => {
                  const on = picked[q.id]?.includes(o);
                  return (
                    <button key={o} type="button" className={`ask-opt${on ? " on" : ""}`} data-testid="ask-opt" aria-pressed={!!on} disabled={busy} onClick={() => toggle(q.id, o, !!q.multiple)}>
                      <span className="ask-letter">{String.fromCharCode(65 + k)}</span>
                      <span>{o}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="ask-opts">
              {hasOpts && q.allowText !== false && (
                <button type="button" className={`ask-custom${showText ? " on" : ""}`} data-testid="ask-custom" disabled={busy} onClick={() => setCustom(c => ({ ...c, [q.id]: !showText }))}>
                  自定义回答
                </button>
              )}
              {showText && (
                <input
                  className="input ask-text"
                  data-testid="ask-text"
                  autoFocus={hasOpts}
                  disabled={busy}
                  value={text[q.id] ?? ""}
                  placeholder={hasOpts ? "写下你自己的回答…" : "写下你的回答…"}
                  onChange={e => setText(t => ({ ...t, [q.id]: e.target.value }))}
                  onKeyDown={e => e.key === "Enter" && !e.nativeEvent.isComposing && ready && submit(false)}
                />
              )}
            </div>
          </div>
        );
      })}
      <div className="ask-foot">
        <span className="ask-count" data-testid="ask-count">
          已答 {done} / {req.questions.length}
        </span>
        <button className="ask-later" data-testid="ask-skip" disabled={busy} onClick={() => submit(true)} title="先不回答，AI 会自己做合理假设并在回复里说明">
          稍后再补充
        </button>
        <button className="btn primary ask-submit" data-testid="ask-submit" disabled={busy || !ready} onClick={() => submit(false)}>
          提交全部回答
        </button>
      </div>
    </div>
  );
}
/** 问答结束后留在对话里的记录：「已回答 N 个问题」+ 每个问题和回答 */
export function AskedCard({ args, output, running }: { args: unknown; output?: string; running: boolean }) {
  const asked = ((args as { questions?: Array<{ question?: string }> } | undefined)?.questions ?? []).map(q => String(q?.question ?? ""));
  let result: { answered?: boolean; answers?: Array<{ question?: string; answer?: string }> } | undefined;
  try {
    result = output ? JSON.parse(output) : undefined;
  } catch {
    /* 不是预期格式就按没有结果处理 */
  }
  const answers = result?.answers ?? [];
  const state = running ? "wait" : result?.answered === false ? "skip" : result?.answered ? "done" : "none";
  const title = state === "wait" ? `等待你回答 ${asked.length} 个问题` : state === "skip" ? "已跳过提问" : state === "done" ? `已回答 ${answers.length} 个问题` : `提了 ${asked.length} 个问题`;
  return (
    <div className={`ask-done ${state}`} data-testid="ask-done">
      <div className="ask-done-head">
        <Icon name={state === "done" ? "check" : state === "skip" ? "x" : "info"} size={14} />
        <b>{title}</b>
      </div>
      {(state === "done" ? answers.map(a => ({ q: a.question ?? "", a: a.answer ?? "" })) : asked.map(q => ({ q, a: "" }))).map((x, i) => (
        <div className="ask-done-qa" key={i}>
          <div>
            Q{i + 1}: {x.q}
          </div>
          {x.a && <div className="ask-done-a">答：{x.a}</div>}
        </div>
      ))}
    </div>
  );
}
