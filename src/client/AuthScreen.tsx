import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Eye, EyeOff, LoaderCircle, Orbit } from "lucide-react";
import { z } from "zod";
import "./auth.css";

type AuthMode = "loading" | "error" | "login" | "bootstrap";
type Credentials = { email?: string; password?: string };
type FieldErrors = { email?: string; password?: string };

function normalizeEmail(value: string): string {
  return value.trim().replace(/＠/g, "@").replace(/[．。｡]/g, ".");
}

const emailSchema = z.string().email();

export function AuthScreen({
  mode,
  onSubmit,
  error,
  usernameLogin = false,
}: {
  mode: AuthMode;
  usernameLogin?: boolean;
  onSubmit: (data: Credentials) => Promise<void> | void;
  error: string;
}) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const [requestError, setRequestError] = useState("");
  const submitting = useRef(false);
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const validationFocus = useRef<"summary" | "email" | "password" | null>(null);
  const setup = mode === "bootstrap";
  const usernameMode = usernameLogin && !setup;
  const displayedError = error || requestError;
  const emailId = id + "-email";
  const passwordId = id + "-password";

  function validateEmail(value: string): string | undefined {
    if (usernameMode) {
      if (!value) return "请填写用户名或邮箱。";
      return emailSchema.safeParse(value).success || /^[A-Za-z0-9_.-]{1,64}$/.test(value)
        ? undefined : "请输入有效的用户名或邮箱。";
    }
    if (!value) return "请填写邮箱，例如 admin@example.com。";
    if (!emailSchema.safeParse(value).success) return "请输入有效邮箱，例如 admin@example.com。";
    return undefined;
  }

  function validatePassword(value: string): string | undefined {
    if (!value) return setup ? "请设置密码，至少12个字符。" : "请输入密码。";
    if (setup && value.length < 12) return "密码至少需要12个字符。";
    if (value.length > 200) return "密码不能超过200个字符。";
    return undefined;
  }

  useEffect(() => {
    setFieldErrors({});
    setSubmitted(false);
    validationFocus.current = null;
    setRequestError("");
    setShowPassword(false);
  }, [mode]);

  useEffect(() => {
    if (displayedError) summary.current?.focus();
  }, [displayedError]);

  useEffect(() => {
    if (validationFocus.current === "summary") summary.current?.focus();
    else if (validationFocus.current === "email") emailInput.current?.focus();
    else if (validationFocus.current === "password") passwordInput.current?.focus();
    validationFocus.current = null;
  }, [validationAttempt]);

  function isSubmittingFocus(target: EventTarget | null): boolean {
    return target instanceof HTMLButtonElement && target.type === "submit";
  }

  async function submit() {
    if (submitting.current || mode === "loading") return;
    setRequestError("");
    if (mode !== "error") {
      const normalized = normalizeEmail(email);
      setEmail(normalized);
      const next = { email: validateEmail(normalized), password: validatePassword(password) };
      setSubmitted(true);
      setFieldErrors(next);
      if (next.email || next.password) {
        validationFocus.current = next.email && next.password
          ? "summary"
          : next.email ? "email" : "password";
        setValidationAttempt((current) => current + 1);
        return;
      }
    }
    submitting.current = true;
    setBusy(true);
    try {
      await onSubmit(mode === "error" ? {} : { email: normalizeEmail(email), password });
    } catch {
      setRequestError("连接未完成，请检查网络后重试。");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const title = mode === "loading"
    ? "正在连接你的空间"
    : mode === "error" ? "面板暂不可用" : setup ? "创建管理员" : "登录面板";
  const subtitle = mode === "loading"
    ? "正在检查面板状态，请稍候。"
    : mode === "error" ? "请检查服务连接，然后重新尝试。"
      : setup ? "首次使用，先创建用于管理服务的账户。" : "输入账户信息，回到你的服务空间。";

  return (
    <main className="nexus-auth">
      <aside className="nexus-auth-story" aria-label="Nexus 服务空间">
        <a className="nexus-auth-brand" href="/" aria-label="Nexus 首页">
          <span className="nexus-auth-mark"><Orbit size={25} aria-hidden="true" /></span>
          <strong>Nexus</strong>
        </a>
        <div className="nexus-auth-story-copy">
          <p>为你的日常入口留一个位置。</p>
          <h2>一处连接，<br />自在抵达。</h2>
          <div className="nexus-auth-constellation" aria-hidden="true">
            <span className="nexus-auth-path path-a" />
            <span className="nexus-auth-path path-b" />
            <span className="nexus-auth-path path-c" />
            <span className="nexus-auth-orbit orbit-a" />
            <span className="nexus-auth-orbit orbit-b" />
            <span className="nexus-auth-hub"><Orbit size={32} /></span>
            <span className="nexus-auth-point point-a" />
            <span className="nexus-auth-point point-b" />
            <span className="nexus-auth-point point-c" />
          </div>
        </div>
        <p className="nexus-auth-story-foot">服务、收藏与动态，回到同一个空间。</p>
      </aside>
      <section className="nexus-auth-main" aria-labelledby={id + "-title"}>
        <form className="nexus-auth-form" noValidate aria-busy={busy || mode === "loading"} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <span className="nexus-auth-mobile-brand"><Orbit size={22} aria-hidden="true" /> Nexus</span>
          <div className="nexus-auth-intro">
            <h1 id={id + "-title"}>{title}</h1>
            <p>{subtitle}</p>
          </div>
          {mode !== "loading" && (
            <>
              {(displayedError || (submitted && fieldErrors.email && fieldErrors.password)) && (
                <div className="nexus-auth-summary" role="alert" tabIndex={-1} ref={summary} aria-labelledby={id + "-error-title"}>
                  <strong id={id + "-error-title"}>{displayedError || "请检查以下信息"}</strong>
                  {!displayedError && (
                    <ul>
                      <li><a href={"#" + emailId} onClick={(event) => { event.preventDefault(); emailInput.current?.focus(); }}>{fieldErrors.email}</a></li>
                      <li><a href={"#" + passwordId} onClick={(event) => { event.preventDefault(); passwordInput.current?.focus(); }}>{fieldErrors.password}</a></li>
                    </ul>
                  )}
                </div>
              )}
              {mode !== "error" && (
                <div className="nexus-auth-fields">
                  <div className="nexus-auth-field">
                    <label htmlFor={emailId}>{usernameMode ? "账号" : "邮箱"}</label>
                    <input
                      ref={emailInput}
                      id={emailId}
                      name="email"
                      type={usernameMode ? "text" : "email"}
                      inputMode={usernameMode ? "text" : "email"}
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      required
                      readOnly={busy}
                      value={email}
                      aria-invalid={Boolean(fieldErrors.email)}
                      aria-describedby={emailId + "-hint" + (fieldErrors.email ? " " + emailId + "-error" : "")}
                      onChange={(event) => {
                        setEmail(event.target.value);
                        setSubmitted(false);
                        if (fieldErrors.email) setFieldErrors((current) => ({ ...current, email: validateEmail(normalizeEmail(event.target.value)) }));
                      }}
                      onBlur={(event) => {
                        if (isSubmittingFocus(event.relatedTarget)) return;
                        const normalized = normalizeEmail(email);
                        setEmail(normalized);
                        setFieldErrors((current) => ({ ...current, email: validateEmail(normalized) }));
                      }}
                      placeholder={usernameMode ? "用户名或邮箱" : "admin@example.com"}
                    />
                    <p className="nexus-auth-hint" id={emailId + "-hint"}>{usernameMode ? "输入用户名或邮箱。" : "例如 admin@example.com；首尾空格和全角 @、句点会自动修正。"}</p>
                    <div className="nexus-auth-error-slot">{fieldErrors.email && <p className="nexus-auth-field-error" id={emailId + "-error"}>{fieldErrors.email}</p>}</div>
                  </div>
                  <div className="nexus-auth-field">
                    <label htmlFor={passwordId}>密码</label>
                    <div className="nexus-auth-password">
                      <input
                        ref={passwordInput}
                        id={passwordId}
                        name="password"
                        type={showPassword ? "text" : "password"}
                        autoComplete={setup ? "new-password" : "current-password"}
                        minLength={setup ? 12 : 1}
                        required
                        readOnly={busy}
                        value={password}
                        aria-invalid={Boolean(fieldErrors.password)}
                        aria-describedby={passwordId + "-hint" + (fieldErrors.password ? " " + passwordId + "-error" : "")}
                        onChange={(event) => {
                          setPassword(event.target.value);
                        setSubmitted(false);
                          if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: validatePassword(event.target.value) }));
                        }}
                        onBlur={(event) => {
                          if (isSubmittingFocus(event.relatedTarget)) return;
                          setFieldErrors((current) => ({ ...current, password: validatePassword(password) }));
                        }}
                      />
                      <button type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} aria-controls={passwordId} onClick={() => setShowPassword((current) => !current)}>
                        {showPassword ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
                      </button>
                    </div>
                    <p className="nexus-auth-hint" id={passwordId + "-hint"}>{setup ? "至少12个字符，建议使用较长且独有的密码。" : "使用创建账户时设置的密码。"}</p>
                    <div className="nexus-auth-error-slot">{fieldErrors.password && <p className="nexus-auth-field-error" id={passwordId + "-error"}>{fieldErrors.password}</p>}</div>
                  </div>
                </div>
              )}
              <button type="submit" className="nexus-auth-submit" disabled={busy}>
                <span>{busy ? (mode === "error" ? "正在重连…" : setup ? "正在创建…" : "正在登录…") : mode === "error" ? "重新连接" : setup ? "创建管理员" : "登录"}</span>
                {busy ? <LoaderCircle className="spin" size={19} aria-hidden="true" /> : <ArrowRight size={19} aria-hidden="true" />}
              </button>
              <p className="nexus-auth-bottom">{setup ? "账户创建后，即可添加并管理你的服务。" : mode === "error" ? "连接恢复后，你的服务入口会重新出现。" : "你的服务入口和收藏，随时准备就绪。"}</p>
            </>
          )}
          {mode === "loading" && <div className="nexus-auth-loading" role="status"><LoaderCircle size={24} className="spin" aria-hidden="true" /><span>正在检查面板状态…</span></div>}
        </form>
      </section>
    </main>
  );
}
