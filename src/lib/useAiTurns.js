import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export function upsertAiTurn(turns, incoming) {
  if (!incoming?.id) return turns;
  const index = turns.findIndex((turn) => turn.id === incoming.id);
  if (index < 0) return [...turns, incoming];
  return turns.map((turn, position) =>
    position === index ? { ...turn, ...incoming } : turn,
  );
}

// Cancel/retry return a Job DTO, not a Turn DTO. Preserve the turn's prompt,
// references and proposals; only apply the authoritative job status fields.
export function aiTurnFromJob(turn, job) {
  return {
    ...turn,
    jobId: job.id || turn.jobId,
    status: job.status,
    error: job.error ?? null,
    stage: job.status === "running" ? turn.stage : job.status,
    ...(job.status === "succeeded" && job.result
      ? {
          summary: job.result.summary ?? turn.summary,
          artboardIds: job.result.artboardIds ?? turn.artboardIds,
          boardRevision: job.result.boardRevision ?? turn.boardRevision,
        }
      : {}),
  };
}

// A successful write stays successful even if its follow-up read fails. The
// caller owns background-read error presentation; it must not retry this write.
export async function acceptAiMutation(mutate, onAccepted, refresh) {
  const response = await mutate();
  onAccepted(response);
  void Promise.resolve()
    .then(refresh)
    .catch(() => {});
  return response;
}

export function useAiTurns(projectId) {
  const [enabled, setEnabled] = useState(false);
  const [turns, setTurns] = useState([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const active = useRef(true);
  const pending = useRef(new Map()),
    requestKeys = useRef(new Map());
  const refreshSequence = useRef(0),
    wakePoll = useRef(() => {});
  const currentProject = useRef(projectId);
  currentProject.current = projectId;

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const current = () =>
      active.current &&
      currentProject.current === projectId &&
      sequence === refreshSequence.current;
    try {
      const next = await api(`/projects/${projectId}/ai-turns`);
      if (current()) {
        setTurns([...next].reverse());
        setError("");
      }
      return next;
    } catch (failure) {
      if (current()) setError(failure.message);
      throw failure;
    }
  }, [projectId]);

  useEffect(() => {
    active.current = true;
    setTurns([]);
    setError("");
    setEnabled(false);
    setSubmitting(pending.current.has(projectId));
    let stopped = false,
      timer,
      polling = false,
      rerun = false;
    const poll = async () => {
      if (stopped) return;
      if (polling) {
        rerun = true;
        return;
      }
      polling = true;
      let interval = 2000;
      try {
        const next = await refresh();
        interval = next.some((turn) =>
          ["queued", "running"].includes(turn.status),
        )
          ? 2000
          : 60000;
      } catch {
        /* refresh already exposes current-scope read errors. */
      } finally {
        polling = false;
      }
      if (!stopped) {
        timer = setTimeout(poll, rerun ? 0 : interval);
        rerun = false;
      }
    };
    const wake = () => {
      if (stopped) return;
      clearTimeout(timer);
      void poll();
    };
    wakePoll.current = wake;
    api("/health")
      .then((health) => {
        if (!stopped) setEnabled(health.aiEnabled === true);
      })
      .catch(() => {});
    wake();
    const onTurn = (event) => {
      if (!event.detail?.projectId || event.detail.projectId === projectId)
        wake();
    };
    window.addEventListener("designx:refresh", wake);
    window.addEventListener("designx:ai-turn", onTurn);
    return () => {
      stopped = true;
      active.current = false;
      ++refreshSequence.current;
      clearTimeout(timer);
      window.removeEventListener("designx:refresh", wake);
      window.removeEventListener("designx:ai-turn", onTurn);
    };
  }, [projectId, refresh]);

  const isCurrent = () =>
    active.current && currentProject.current === projectId;
  const publish = (turn) => {
    if (!isCurrent()) return;
    // Invalidate GETs started before this accepted mutation so they cannot erase
    // its newly queued turn or restore a cancelled/failed status over its reply.
    ++refreshSequence.current;
    setTurns((previous) =>
      upsertAiTurn(
        previous,
        typeof turn === "function" ? turn(previous) : turn,
      ),
    );
    setError("");
  };
  const refreshInBackground = () => {
    if (isCurrent()) wakePoll.current();
  };
  const requestKey = (signature) => {
    if (!requestKeys.current.has(signature))
      requestKeys.current.set(signature, crypto.randomUUID());
    return requestKeys.current.get(signature);
  };

  const start = (body) => {
    if (pending.current.has(projectId)) return pending.current.get(projectId);
    const signature = `create:${projectId}:${JSON.stringify(body)}`;
    const key = requestKey(signature);
    setSubmitting(true);
    const request = acceptAiMutation(
      () =>
        api(`/projects/${projectId}/ai-turns`, {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body,
        }),
      (response) => {
        requestKeys.current.delete(signature);
        publish(response.turn);
      },
      refreshInBackground,
    ).finally(() => {
      pending.current.delete(projectId);
      if (isCurrent()) setSubmitting(false);
    });
    pending.current.set(projectId, request);
    return request;
  };

  const changeJob = (turn, action) =>
    acceptAiMutation(
      () => api(`/jobs/${turn.jobId}/${action}`, { method: "POST" }),
      (job) =>
        publish((previous) =>
          aiTurnFromJob(
            previous.find((item) => item.id === turn.id) || turn,
            job,
          ),
        ),
      refreshInBackground,
    );
  const cancel = (turn) => changeJob(turn, "cancel");
  const retry = (turn) => changeJob(turn, "retry");
  const details = (turn) => api(`/ai-turns/${turn.id}`);
  const apply = (turn, proposalId, baseRevision) => {
    const signature = `apply:${projectId}:${turn.id}:${proposalId}:${baseRevision}`;
    const key = requestKey(signature);
    return acceptAiMutation(
      () =>
        api(`/ai-turns/${turn.id}/apply`, {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: { proposalId, baseRevision },
        }),
      (response) => {
        requestKeys.current.delete(signature);
        publish(response.turn);
      },
      refreshInBackground,
    );
  };
  return {
    enabled,
    turns,
    error,
    submitting,
    start,
    refresh,
    cancel,
    retry,
    details,
    apply,
  };
}
