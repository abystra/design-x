import React, { useEffect, useState } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { api } from "../lib/api";
import App from "../App";
import "./auth.css";

export default function Auth() {
  const [session, setSession] = useState(null),
    [checking, setChecking] = useState(true),
    [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    api("/auth/me")
      .then(setSession)
      .catch((e) => {
        if (e.status !== 401) setError("暂时无法连接服务，请检查后重试。");
      })
      .finally(() => setChecking(false));
    const expired = () => setSession(null);
    window.addEventListener("designx:unauthorized", expired);
    return () => window.removeEventListener("designx:unauthorized", expired);
  }, []);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      setSession(
        await api(`/auth/${register ? "register" : "login"}`, {
          method: "POST",
          body: data,
        }),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      await api("/auth/logout", { method: "POST" });
      setSession(null);
    } catch (e) {
      setError(e.message);
    }
  }
  if (checking)
    return (
      <div className="auth-loading">
        <LoaderCircle className="st-spin" /> 正在打开创作空间…
      </div>
    );
  if (session)
    return (
      <App
        key={session.user.id}
        sessionUser={session.user}
        workspace={session.workspace}
        onLogout={logout}
      />
    );
  return (
    <div className="auth-page">
      <section className="auth-story">
        <div className="auth-logo">
          ✳ design<span>x</span>
        </div>
        <div>
          <span className="eyebrow">A SPACE FOR YOUR IDEAS</span>
          <h1>
            给灵感，
            <br />
            一个自己的空间。
          </h1>
          <p>
            收藏素材，打磨设计。
            <br />
            让每一次创作，都有迹可循。
          </p>
        </div>
        <img src="/assets/coffee.jpg" alt="温暖的咖啡创作灵感" />
      </section>
      <main className="auth-form-wrap">
        <form onSubmit={submit}>
          <span className="eyebrow">YOUR CREATIVE WORKSPACE</span>
          <h2>{register ? "开始你的创作旅程" : "欢迎回来"}</h2>
          <p>
            {register
              ? "创建账户，保存属于你的每一份灵感。"
              : "登录后继续上次的灵感。"}
          </p>
          {register && (
            <label>
              你的名字
              <input
                name="name"
                autoComplete="name"
                required
                maxLength={60}
                placeholder="怎么称呼你"
              />
            </label>
          )}
          <label>
            邮箱
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              placeholder="you@example.com"
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete={register ? "new-password" : "current-password"}
              required
              minLength={10}
              maxLength={128}
              placeholder="至少 10 个字符"
            />
          </label>
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? (
              <LoaderCircle className="st-spin" size={18} />
            ) : (
              <ArrowRight size={18} />
            )}{" "}
            {register ? "创建账户" : "进入创作空间"}
          </button>
          <button
            type="button"
            className="auth-switch"
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register ? "已有账户？登录" : "第一次来？创建账户"}
          </button>
          <small>设计与素材将保存在你的个人工作空间中。</small>
        </form>
      </main>
    </div>
  );
}
