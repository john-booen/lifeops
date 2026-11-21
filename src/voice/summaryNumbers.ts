const digits = "零一二三四五六七八九";
const chineseNumerals = "零〇一二两三四五六七八九十百千万亿";
const amount = `[${chineseNumerals}]+(?:点[零〇一二两三四五六七八九]+)?`;
const boundary = "(?=[个件项条笔次只份杯张篇步字位套组台本页题周天月年日小时分钟秒成元角分美元欧港人民币公里克公斤吨米%倍，,:：]|$)";
const amountPattern = new RegExp(`百分之([+-]?(?:${amount}|\\d+(?:\\.\\d+)?))|(${amount})成|(${amount})${boundary}`, "gu");
const numericMarker = new RegExp(`\\p{N}|百分之|半数|[一近过]半|半${boundary}|[俩仨]${boundary}|第[${chineseNumerals}]|${amount}${boundary}|[十百千万亿][${chineseNumerals}]`, "u");
const percentToken = /(约?)([+-]?)(\d+(?:\.\d+)?)%/gu;

function smallInteger(value: string): number {
  if (!value) return 0;
  const simple = /^([一二三四五六七八九]千)?(零?[一二三四五六七八九]百)?(零?[一二三四五六七八九]?十)?(零?[一二三四五六七八九])?$/u.exec(value);
  if (!simple || /[百千][一二三四五六七八九]$/u.test(value)) return Number.NaN;
  const [, thousands, hundreds, tens, ones] = simple;
  const tensDigit = tens?.replace(/^零/u, "").at(-2);
  return (thousands ? digits.indexOf(thousands[0]) * 1000 : 0)
    + (hundreds ? digits.indexOf(hundreds.at(-2)!) * 100 : 0)
    + (tens ? (tensDigit ? digits.indexOf(tensDigit) : 1) * 10 : 0)
    + (ones ? digits.indexOf(ones.at(-1)!) : 0);
}

function normalizeNumber(value: string): string {
  const sign = /^[+-]/u.test(value) ? value[0] : "";
  const [whole, fraction] = value.slice(sign.length).replace(/〇/gu, "零").replace(/两/gu, "二").split("点");
  const asDigits = (text: string) => [...text].map(char => digits.indexOf(char)).join("");
  const suffix = fraction ? `.${asDigits(fraction)}` : "";
  if (/^[零一二三四五六七八九]+$/u.test(whole)) {
    return `${sign}${asDigits(whole)}${suffix}`;
  }
  const sections = /^(?:([^万亿]+)亿)?(?:([^万亿]+)万)?([^万亿]*)$/u.exec(whole);
  if (!sections) return value;
  const [, hundredsOfMillions, tensOfThousands, remainder] = sections;
  if ((hundredsOfMillions || tensOfThousands) && remainder && !remainder.startsWith("零")
    && !(tensOfThousands && remainder.includes("千"))) return value;
  const result = smallInteger(hundredsOfMillions ?? "") * 100_000_000
    + smallInteger(tensOfThousands ?? "") * 10_000 + smallInteger(remainder.replace(/^零(?=.)/u, ""));
  return Number.isSafeInteger(result) ? `${sign}${result}${suffix}` : value;
}

function numericSentences(text: string): string[] {
  return text.normalize("NFKC").split(/[。！？!?；;\r\n]/u)
    .map(sentence => sentence.trim().replace(/^(?:#{1,6}\s+|[-*+]\s+)/u, "").replace(/\*\*|__|`/gu, "")
      .replace(/(?<=\d),(?=\d{3}(?!\d))/gu, "")
      .replace(/\s+/gu, "")
      .replace(/\.$/u, "")
      .replace(/[−﹣]|负(?=[零〇一二两三四五六七八九十百千万亿\d])/gu, "-")
      .replace(/正(?=[零〇一二两三四五六七八九十百千万亿\d])/gu, "+")
      .replace(amountPattern, (match, percent: string | undefined, tenths: string | undefined, number: string | undefined) => {
        if (percent !== undefined) return `${normalizeNumber(percent)}%`;
        if (tenths !== undefined) {
          const value = Number(normalizeNumber(tenths));
          return Number.isFinite(value) && value >= 0 && value <= 10 ? `${value * 10}%` : match;
        }
        return normalizeNumber(number!);
      })
      .replace(/(?:大约|约|大概|接近|近)(?=[+-]?\d)/gu, "约")
      .replace(/([+-]?\d+(?:\.\d+)?(?:%|美元|欧元|元|项|个|笔|次|条)?)(?:左右|上下)/gu, "约$1"))
    .filter(sentence => numericMarker.test(sentence.replace(/[上下前后]半[年月]/gu, "")));
}

function matchesRoundedPercentages(source: string, claim: string): boolean {
  if (source.replace(percentToken, "%") !== claim.replace(percentToken, "%")) return false;
  const original = [...source.matchAll(percentToken)], spoken = [...claim.matchAll(percentToken)];
  return original.length > 0 && original.length === spoken.length && spoken.every((token, index) => {
    const expected = original[index];
    if (token[0] === expected[0]) return true;
    return token[1] === "约" && token[2] === expected[2]
      && token[3] === String(Math.round(Number(expected[3])));
  });
}

export function hasGroundedSpeechNumbers(detail: string, spoken: string): boolean {
  const claims = numericSentences(spoken);
  if (!claims.length) return true;
  const evidence = new Set(numericSentences(detail));
  // Compare complete statements so the same digits cannot migrate to a different metric or period.
  return claims.every(claim => {
    const comparable = claim.replace(/约([+-]?\d+(?:\.\d+)?)(%?)/gu, (token, value, percent) => percent ? token : value);
    return evidence.has(claim) || evidence.has(comparable) || [...evidence].some(source => matchesRoundedPercentages(source, comparable));
  });
}
