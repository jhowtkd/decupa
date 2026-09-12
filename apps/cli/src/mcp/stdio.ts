import { runDoctor } from "../doctor.ts";
import { startApp } from "../app/server.ts";
import { writeCredentials } from "@decupa/triage";
import { dispatch } from "./dispatch.ts";
import { encodeFrame, FrameParser } from "./protocol.ts";
import { createMcpSession } from "./tools.ts";

export async function runMcpStdio(
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const session = createMcpSession({
    doctor: () => runDoctor(),
    startApp,
    writeCredentials,
    cwd: () => process.cwd(),
  });
  const parser = new FrameParser();
  stdin.on("data", (chunk: Buffer | string) => {
    const messages = parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    void (async () => {
      for (const message of messages) {
        const reply = await dispatch(message, session);
        if (reply) stdout.write(encodeFrame(reply));
      }
    })();
  });
  await new Promise<void>((resolve) => {
    stdin.on("end", () => resolve());
    stdin.on("close", () => resolve());
  });
}
