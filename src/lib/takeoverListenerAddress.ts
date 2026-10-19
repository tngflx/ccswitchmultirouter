/** UI validation only; the backend independently enforces the bind boundary. */
export function normalizeTakeoverListenAddress(address: string): string | null {
  const value = address.trim();
  if (value === "localhost") return "127.0.0.1";
  // Keep IPv4 parsing aligned with Rust IpAddr: no abbreviated, octal or hex forms.
  if (
    /^127\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.test(value)
  ) {
    return value.split(".").every((part) => Number(part) <= 255) ? value : null;
  }
  if (value.includes(":")) {
    const literal =
      value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
    if (!/^[0-9a-fA-F:]+$/.test(literal)) return null;
    try {
      // URL canonicalization recognizes expanded IPv6 loopback. Mapped IPv4
      // and scoped addresses deliberately remain unsupported on both sides.
      if (new URL(`http://[${literal}]/`).hostname === "[::1]") return "::1";
    } catch {
      return null;
    }
  }
  return null;
}
