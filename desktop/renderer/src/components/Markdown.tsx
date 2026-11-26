import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./Icon";
import { highlight, parseFence } from "../lib/highlight";

const SQL_LANGS = new Set(["sql", "mysql", "pgsql", "postgresql", "postgres", "plpgsql"]);

function CodeBlock({ lang, code, onRunSql }: { lang: string; code: string; onRunSql?: (sql: string) => void }) {
  const [copied, setCopied] = useState(false);
  // 信息串可能是 java，也可能是「74:85:src/Foo.java」这种代码引用：后者表头显示文件和行号，语言按扩展名认
  const fence = useMemo(() => parseFence(lang), [lang]);
  const toks = useMemo(() => highlight(code, fence.lang), [code, fence.lang]);
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span title={fence.path} className="codeblock-name">
          {fence.path ? `${fence.range}  ${fence.path}` : lang || "text"}
        </span>
        {onRunSql && SQL_LANGS.has(lang.toLowerCase()) && (
          <button className="icon-btn sm codeblock-run" data-testid="codeblock-run" title="新开一个查询页，带上这段 SQL 直接运行" style={{ marginLeft: "auto" }} onClick={() => onRunSql(code)}>
            <Icon name="play" size={12} />
            <span>运行</span>
          </button>
        )}
        <button
          className="icon-btn sm"
          title="复制"
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={14} />
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre>
        <code>
          {toks.map((t, i) => (t.c ? <span key={i} className={`tk-${t.c}`}>{t.s}</span> : t.s))}
        </code>
      </pre>
    </div>
  );
}

/** 渲染助手回复的 Markdown。不渲染原始 HTML（react-markdown 默认行为），外链交给主进程打开。 */
export function Markdown({ text, onRunSql }: { text: string; onRunSql?: (sql: string) => void }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code({ className, children }) {
            const code = String(children ?? "").replace(/\n$/, "");
            const lang = /language-(\S+)/.exec(className ?? "")?.[1];
            if (!lang && !code.includes("\n")) {
              // 行内代码里写的网址也要能点开
              return /^https?:\/\/\S+$/i.test(code) ? (
                <a href={code} target="_blank" rel="noreferrer noopener">
                  <code className="inline">{code}</code>
                </a>
              ) : (
                <code className="inline">{code}</code>
              );
            }
            return <CodeBlock lang={lang ?? ""} code={code} onRunSql={onRunSql} />;
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="md-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
