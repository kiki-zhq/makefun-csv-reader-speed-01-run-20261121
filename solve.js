// Fast exact drop-in for make.fun's csv-reader 1.0.0.
//
// run(input) returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors}. The reference reads one character at a time and
// builds every field by appending one character at a time; this reader does
// the same reading, but in slices. The two ideas that make it fast:
//
//  - An unquoted field is one slice: the next comma is found with indexOf
//    (native) and the line end is found once per record, not once per field,
//    the field is text.slice(pos, end), and a stray CR inside it is found
//    by scanning only that short slice, never the rest of the file.
//  - A whole physical line with no quote and no stray CR is one split(','):
//    the line end, the next quote and the next CR are each found once per
//    record, and the line is split natively instead of field by field.
//  - A quoted field is one slice too: the next quote is found with indexOf,
//    "" inside it collapses to one quote by joining segments, and CR / LF
//    inside it are converted and counted only once, on the joined value.
//
// Everything else follows the reference, in the same order, with the same
// errors: BOM dropped at the very start, empty lines are no records, a CR
// outside quotes that is not followed by LF is dropped (stray_cr), a field
// that opens with a quote runs to the next quote that is not doubled (each
// CRLF or lone CR inside it read as LF), junk after its closing quote is
// appended as it stands (quote_junk, when the field ends), a quote that
// never closes is a literal character and the text after it is read again
// as unquoted (unterminated_quote), a quote inside an unquoted field is a
// literal character, fields stay strings, and rows are padded (short_row)
// or cut (long_row) to the first record's width.

const COMMA = 0;
const LINE = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  let lineEnd = -1;
  let lineEndValid = false;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    let fields;
    let ended;
    let quoted = false;

    // The line end, once per record. A physical line with no quote and no
    // stray CR is a whole record on its own: split it natively.
    const lfPos = text.indexOf('\n', pos);
    const hasLf = lfPos !== -1;
    lineEnd = hasLf ? lfPos : n;
    lineEndValid = true;
    const qPos = text.indexOf('"', pos);
    const crPos = text.indexOf('\r', pos);
    let fast = false;
    if ((qPos === -1 || qPos > lineEnd) && (crPos === -1 || crPos > lineEnd || (hasLf && crPos === lineEnd - 1))) {
      const segEnd = hasLf && crPos === lineEnd - 1 ? lineEnd - 1 : lineEnd;
      fields = text.slice(pos, segEnd).split(',');
      pos = hasLf ? lineEnd + 1 : n;
      if (hasLf) line += 1;
      fast = true;
    }

    if (!fast) {
    fields = [];
    do {
      ended = undefined;
      let value = '';
      let junkMode = false;
      quoted = text.charCodeAt(pos) === 34;

      if (quoted) {
        const open = pos;
        let start = pos + 1;
        let parts = null;
        let closedPos = -1;
        while (true) {
          const q = text.indexOf('"', start);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) !== 34) {
            closedPos = q;
            break;
          }
          // A doubled quote: one literal quote, keep scanning after it.
          if (parts === null) parts = [text.slice(start, q), '"'];
          else {
            parts.push(text.slice(start, q));
            parts.push('"');
          }
          start = q + 2;
        }
        if (closedPos === -1) {
          // The quote never closes: it is a literal character, and the
          // text after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          value = '"';
          lineEndValid = false;
          // Fall through to the unquoted scan below.
        } else {
          value = parts === null ? text.slice(start, closedPos) : parts.join('') + text.slice(start, closedPos);
          // Each CRLF or lone CR inside quotes is one LF, and each counts
          // as a line. A value with no CR keeps its LFs as they are.
          if (value.indexOf('\r') !== -1) {
            let out = '';
            let count = 0;
            for (let i = 0; i < value.length; i += 1) {
              const cc = value.charCodeAt(i);
              if (cc === 13) {
                out += '\n';
                count += 1;
                if (value.charCodeAt(i + 1) === 10) i += 1;
              } else {
                out += value[i];
                if (cc === 10) count += 1;
              }
            }
            value = out;
            line += count;
          } else {
            let idx = value.indexOf('\n');
            if (idx !== -1) {
              let count = 0;
              while (idx !== -1) {
                count += 1;
                idx = value.indexOf('\n', idx + 1);
              }
              line += count;
            }
          }
          pos = closedPos + 1;
          // A quoted field may have run over lines, so the record's line
          // end no longer holds for the fields after it.
          lineEndValid = false;
          if (pos >= n) {
            ended = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              ended = COMMA;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              ended = LINE;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              ended = LINE;
            } else {
              // What follows the closing quote is appended as it stands,
              // up to the next comma or line break.
              junkMode = true;
              // Fall through to the unquoted scan below.
            }
          }
        }
      }

      if (ended === undefined) {
        // Unquoted scan: for a plain unquoted field, for the junk after a
        // closing quote, and for the re-read after an unterminated quote.
        // Each step slices to the next comma or LF (indexOf, native), so a
        // field with no stray CR is a single slice. A CR inside the slice
        // is handled by scanning only that slice.
        let added = 0;
        while (true) {
          if (pos >= n) {
            ended = END;
            break;
          }
          const comma = text.indexOf(',', pos);
          if (!lineEndValid) {
            const lf2 = text.indexOf('\n', pos);
            lineEnd = lf2 === -1 ? n : lf2;
            lineEndValid = true;
          }
          const lf = lineEnd === n ? -1 : lineEnd;
          if (comma === -1 && lf === -1) {
            const seg = text.slice(pos);
            const r = seg.indexOf('\r');
            if (r === -1) {
              if (value.length === 0) value = seg;
              else value += seg;
              added += seg.length;
            } else {
              for (let i = 0; i < seg.length; i += 1) {
                if (seg.charCodeAt(i) === 13) {
                  errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                } else {
                  value += seg[i];
                  added += 1;
                }
              }
            }
            pos = n;
            ended = END;
            break;
          }
          const end = comma === -1 ? lf : lf === -1 ? comma : comma < lf ? comma : lf;
          const isComma = end === comma;
          const seg = text.slice(pos, end);
          const r = seg.indexOf('\r');
          if (r === -1) {
            if (value.length === 0) value = seg;
            else value += seg;
            added += seg.length;
            pos = end + 1;
            if (isComma) {
              ended = COMMA;
            } else {
              line += 1;
              ended = LINE;
            }
            break;
          }
          for (let i = 0; i < seg.length; i += 1) {
            if (seg.charCodeAt(i) === 13) {
              // A CR at the very end of a line is the CRLF break itself;
              // any other CR outside quotes is dropped (stray_cr).
              if (!(i === seg.length - 1 && !isComma)) {
                errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              }
            } else {
              value += seg[i];
              added += 1;
            }
          }
          pos = end + 1;
          if (isComma) {
            ended = COMMA;
          } else {
            line += 1;
            ended = LINE;
          }
          break;
        }
        if (junkMode && added > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }

      fields.push(value);
    } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? columns ?? [] : null, rows, errors };
}
