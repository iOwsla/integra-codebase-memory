/** Adapt block comments for the upstream grammar without moving UTF-16 source positions. */
export function maskPrismaBlockComments(source: string): string {
  const parts: string[] = [];
  let copied = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '"') {
      // Comment delimiters inside a string are data, including escaped quotes.
      for (i++; i < source.length; i++) {
        if (source[i] === "\\") i++;
        else if (source[i] === '"') break;
      }
    } else if (source[i] === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++;
    } else if (source[i] === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      // Leave an unterminated opener visible so the parser reports its original location.
      if (end === -1) break;
      parts.push(source.slice(copied, i), source.slice(i, end + 2).replace(/[^\r\n]/g, " "));
      copied = end + 2;
      i = end + 1;
    }
  }
  if (!parts.length) return source;
  parts.push(source.slice(copied));
  return parts.join("");
}
