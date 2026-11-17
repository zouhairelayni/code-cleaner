export function saveTask(task: { title: string }) {
  return { ok: true, id: Math.random().toString(36).slice(2), title: task.title };
}
