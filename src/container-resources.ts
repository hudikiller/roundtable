/** runc's systemd driver may omit a zero swap limit; set the property explicitly. */
export function memoryArgs(mebibytes: number): string[] {
  return ["--memory", `${mebibytes}m`, "--memory-swap", `${mebibytes}m`,
    "--annotation", "org.systemd.property.MemorySwapMax=uint64 0"];
}
