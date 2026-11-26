import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildCsv, buildXlsx, crc32, neutralizeFormula, safeSheetName, xmlEscape } from '../src/xlsx.ts';

/** Read entries of our ZIP (deflate) back, to check the container without external tools. */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const comp = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const data = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + comp);
    const raw = inflateRawSync(data);
    expect(crc32(raw)).toBe(buf.readUInt32LE(i + 14));
    out.set(name, raw.toString('utf8'));
    i += 30 + nameLen + extra + comp;
  }
  expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50);
  return out;
}

describe('formula-injection defence', () => {
  it.each([
    ['=HYPERLINK("http://evil","x")', `'=HYPERLINK("http://evil","x")`],
    ['+1+2', `'+1+2`],
    ['-2+3', `'-2+3`],
    ['@SUM(A1)', `'@SUM(A1)`],
    ['\tcmd', `'\tcmd`],
    ['normal text', 'normal text'],
    ['Hình nền động 🎉', 'Hình nền động 🎉'],
  ])('%j', (input, expected) => expect(neutralizeFormula(input)).toBe(expected));
});

describe('CSV', () => {
  it('quotes RFC 4180 fields, neutralizes formulas, keeps numbers and null, starts with a UTF-8 BOM', () => {
    const csv = buildCsv([
      ['caption', 'likes', 'url'],
      ['=1+1, "quoted"\nline', 5, { url: 'https://bsky.app/x' }],
      [null, null, undefined],
    ]).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe(`caption,likes,url\r\n"'=1+1, ""quoted""\nline",5,https://bsky.app/x\r\n,,\r\n`);
  });
});

describe('XLSX writer', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('writes a valid OOXML package with inline strings, numbers, nulls and safe hyperlinks', () => {
    const buf = buildXlsx([
      { name: 'Posts', rows: [['caption', 'likes', 'url'], ['<b>&"x"</b> 🎉', 42, { url: 'https://bsky.app/profile/a.b', text: 'say "hi"' }], [null, null, { url: 'javascript:alert(1)' }]] },
      { name: 'Posts', rows: [['dup name']] },
    ]);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const files = unzip(buf);
    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Posts" sheetId="1"');
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Posts_2" sheetId="2"');
    const s1 = files.get('xl/worksheets/sheet1.xml')!;
    expect(s1).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt; 🎉</t></is></c>');
    expect(s1).toContain('<c r="B2"><v>42</v></c>');
    expect(s1).toContain('HYPERLINK(&quot;https://bsky.app/profile/a.b&quot;,&quot;say &quot;&quot;hi&quot;&quot;&quot;)'); // quotes doubled inside the formula
    expect(s1).not.toContain('javascript:alert(1)&quot;'); // non-https URL is plain text, never a formula
    expect(s1).toContain('<c r="C3" t="inlineStr"><is><t xml:space="preserve">javascript:alert(1)</t></is></c>');
    expect(s1).not.toContain('r="A3"'); // nulls are empty cells, not 0
  });

  it('sanitizes sheet names and strips characters XML cannot carry', () => {
    const used = new Set<string>();
    expect(safeSheetName('a/b:c*d?e[f]', used)).toBe('a_b_c_d_e_f_');
    expect(safeSheetName('x'.repeat(40), used)).toHaveLength(31);
    expect(xmlEscape('ok\u0001\u0008text')).toBe('oktext');
  });
});
