import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

const pendingStates = new Set([
  "queued",
  "running",
  "submitting",
  "processing",
  "checking",
  "received",
  "pending",
]);
export function isGenerationPending(item) {
  return (
    pendingStates.has(item.executionStatus || item.status) ||
    pendingStates.has(item.assetStatus)
  );
}
export function generationPrompt(generation) {
  return (
    generation?.recipe?.parameters?.prompt ||
    generation?.recipe?.parameters?.headline ||
    generation?.prompt ||
    ""
  );
}
export function generationPlacementKey(generation) {
  return `${generation.id}:${(generation.outputs || [])
    .filter((output) => output.placementStatus === "board")
    .map(
      (output) =>
        `${output.id || output.assetId}:${output.assetVersionId}:${(output.documentIds || []).join(",")}`,
    )
    .sort()
    .join("|")}`;
}
export function upsertGeneration(items, incoming) {
  if (!incoming?.id) return items;
  return items.some((item) => item.id === incoming.id)
    ? items.map((item) =>
        item.id === incoming.id ? { ...item, ...incoming } : item,
      )
    : [incoming, ...items];
}
export function useCreativeActivity(projectId) {
  const [generations, setGenerations] = useState([]);
  const [activities, setActivities] = useState([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const current = useRef(projectId),
    sequence = useRef(0),
    requestKeys = useRef(new Map()),
    pending = useRef(new Map());
  current.current = projectId;
  const refresh = useCallback(async () => {
    const read = ++sequence.current;
    const responses = await Promise.allSettled([
      api(`/projects/${projectId}/generations`),
      api(`/projects/${projectId}/activities`),
    ]);
    if (current.current !== projectId || read !== sequence.current) return [];
    const [generationResponse, activityResponse] = responses;
    if (generationResponse.status === "fulfilled")
      setGenerations(generationResponse.value);
    if (activityResponse.status === "fulfilled")
      setActivities(activityResponse.value);
    const failure = responses.find(
      (response) => response.status === "rejected",
    );
    setError(failure ? failure.reason.message : "");
    return generationResponse.status === "fulfilled"
      ? generationResponse.value
      : [];
  }, [projectId]);
  useEffect(() => {
    setGenerations([]);
    setActivities([]);
    setError("");
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
      const list = await refresh();
      polling = false;
      if (!stopped) {
        timer = setTimeout(
          poll,
          rerun ? 0 : list.some(isGenerationPending) ? 2000 : 30000,
        );
        rerun = false;
      }
    };
    const wake = () => {
      clearTimeout(timer);
      void poll();
    };
    wake();
    window.addEventListener("designx:refresh", wake);
    return () => {
      stopped = true;
      ++sequence.current;
      clearTimeout(timer);
      window.removeEventListener("designx:refresh", wake);
    };
  }, [refresh]);
  const mutate = (path, body = {}) => {
    const signature = `${projectId}:${path}:${JSON.stringify(body)}`;
    if (pending.current.has(signature)) return pending.current.get(signature);
    if (!requestKeys.current.has(signature))
      requestKeys.current.set(signature, crypto.randomUUID());
    setSubmitting(true);
    const request = api(path, {
      method: "POST",
      headers: { "Idempotency-Key": requestKeys.current.get(signature) },
      body,
    })
      .then((response) => {
        requestKeys.current.delete(signature);
        if (current.current === projectId) {
          ++sequence.current;
          setGenerations((items) =>
            upsertGeneration(items, response.generation),
          );
          setError("");
          // Accepted writes must remain accepted when their follow-up reads fail.
          void refresh().catch(() => {});
        }
        return response;
      })
      .finally(() => {
        pending.current.delete(signature);
        if (current.current === projectId) setSubmitting(false);
      });
    pending.current.set(signature, request);
    return request;
  };
  return {
    generations,
    activities,
    error,
    submitting,
    refresh,
    start: (body) => mutate(`/projects/${projectId}/generations`, body),
    recipe: (body) => mutate(`/projects/${projectId}/recipes`, body),
    cancel: (generation) => mutate(`/generations/${generation.id}/cancel`),
    retryIngestion: (generation) =>
      mutate(`/generations/${generation.id}/retry-ingestion`),
    regenerate: (generation) =>
      mutate(`/generations/${generation.id}/regenerate`),
  };
}
