/**
 * QR codes for authenticator enrolment, drawn on the server (qrcode-generator) and sent as one SVG path — the
 * browser gets no QR library and no innerHTML. Horizontal runs of dark modules become one rectangle each.
 *
 *   const qr = qrPath(otpauthUri);        // { size: 33, path: "M4 4h7v1h-7z…" } — size excludes the quiet zone
 *   <svg viewBox={`-4 -4 ${qr.size + 8} ${qr.size + 8}`}><path d={qr.path} /></svg>
 */
import qrcode from "qrcode-generator";

export type QrPath = { size: number; path: string };

export function qrPath(text: string): QrPath {
  // "M" (15% recovery) keeps an otpauth URI small enough to scan from a phone held at arm's length.
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  let path = "";
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (!qr.isDark(row, col)) {
        col++;
        continue;
      }
      let run = 1;
      while (col + run < size && qr.isDark(row, col + run)) run++;
      path += `M${col} ${row}h${run}v1h-${run}z`;
      col += run;
    }
  }
  return { size, path };
}
