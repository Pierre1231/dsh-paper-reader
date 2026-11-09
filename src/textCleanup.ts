/**
 * Text taken from a PDF text layer keeps the printed line breaks and the
 * hyphenation of words split across lines ("multi-\nplicative"). Both hurt
 * translation and explanation. This restores running text; it never touches
 * the PDF or the on-screen selection.
 */
const SENTENCE_END = /[.!?:;。！？：；]["'”’)\]]?$/;
const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/;

export function cleanPdfText(input: string): string {
  const lines = input.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/[ \t ]+/g, ' ').trim());
  let out = '';
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) {
      // An empty line is a real paragraph break.
      if (out && !out.endsWith('\n\n')) out = out.replace(/\n?$/, '\n\n');
      continue;
    }
    if (!out || out.endsWith('\n')) { out += line; continue; }
    const previous = out;
    const last = previous[previous.length - 1];
    const first = line[0];
    // Soft hyphenation: "multi-" + "plicative" → "multiplicative".
    if (/[A-Za-z]{2}-$/.test(previous) && /^[a-z]/.test(line)) { out = previous.slice(0, -1) + line; continue; }
    // A finished sentence followed by a capitalised or numbered start is most
    // likely a new paragraph or list item in the selection.
    if (SENTENCE_END.test(previous) && /^([A-Z0-9•\-–—(\[]|\d+\.)/.test(line) && line.length > 2 && previous.length > 40) { out += '\n' + line; continue; }
    // CJK text has no spaces between lines.
    out += CJK.test(last) && CJK.test(first) ? line : ' ' + line;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/** Characters that only appear in mathematics (or in inline math within prose). */
const MATH = /[=≈≠≤≥±×÷·∑∏∫∂∇√∞∈∉⊂⊆⊃∪∩∀∃→←↔⇒⇔⊗⊕αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ]/;

/** True when an image of the passage helps a model read it (formulas). */
export function looksLikeMath(text: string): boolean {
  return MATH.test(text);
}
