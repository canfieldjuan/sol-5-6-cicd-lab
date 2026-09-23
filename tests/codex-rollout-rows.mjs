// Codex rollout row builders, in the shapes verified on real rollouts
// (contract 5.3). Shared by the Stop gate tests.
const row = (type, payload) => JSON.stringify({ timestamp: "2026-09-23T00:00:00Z", type, payload });
export const R = {
  meta: () => row("session_meta", { id: "s", cwd: "/w" }),
  turn: (id) => row("event_msg", { type: "task_started", turn_id: id }),
  user: (text) => row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] }),
  say: (text) => row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] }),
  echo: (text) => row("event_msg", { type: "agent_message", message: text }),
  exec: (calls, id = "c") => row("response_item", { type: "custom_tool_call", name: "exec", call_id: id, input: calls.map((c) => `await tools.exec_command(${JSON.stringify(typeof c === "string" ? { cmd: c } : c)});`).join("\n") }),
  out: (text, id = "c") => row("response_item", { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text }] }),
  chunk: (output, exitCode, id = "c") => row("response_item", { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text: JSON.stringify({ chunk_id: "x", exit_code: exitCode, output }) }] }),
  fnOut: (text) => row("response_item", { type: "function_call_output", call_id: "f", output: text }),
  report: (text) => row("response_item", { type: "agent_message", author: "/root/child", recipient: "/root", content: [{ type: "input_text", text }] }),
  done: (id, last) => row("event_msg", { type: "task_complete", turn_id: id, last_agent_message: last }),
  // What actually ran (newer rollouts): one row per execution, real argv and cwd.
  ran: (command, cwd = "/r") => row("event_msg", { type: "item_completed", thread_id: "s", item: { type: "CommandExecution", id: "e", command: ["/bin/bash", "-lc", command], cwd: `file://${cwd}`, status: "completed", exit_code: 0, aggregated_output: "" } }),
  loop: (cmds, workdir = "/r") => row("response_item", { type: "custom_tool_call", name: "exec", call_id: "l", input: `for(const cmd of ${JSON.stringify(cmds)}){const r=await tools.exec_command({cmd,workdir:${JSON.stringify(workdir)}});text(r);}` })
};

