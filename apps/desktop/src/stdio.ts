/** A desktop window can outlive the terminal or dev launcher reading its logs. */
export function ignoreBrokenPipeErrors(...streams: NodeJS.WritableStream[]): void {
  for (const stream of streams) stream.on("error", (error: NodeJS.ErrnoException) => {
    // Terminal output is optional; an unhandled stream error opens Electron's error dialog.
    if (error.code !== "EPIPE") throw error;
  });
}
