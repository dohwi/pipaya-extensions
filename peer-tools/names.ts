// Names for sessions: Korean, or the same names romanized for other UI languages. The first one not taken is used.

/** Korean names, given to sessions in order; the first one not taken by an active session is used. */
export const MEMBER_NAMES_KO = [
	"철수", "미나", "가온", "영희", "민준", "나린", "지우", "도하", "하준", "라희",
	"서연", "도윤", "서준", "예준", "시우", "주원", "지호", "지후", "준우", "현우",
	"도현", "건우", "우진", "승민", "유준", "재민", "태양", "선우", "은호", "정우",
	"시윤", "이안", "라온", "다온", "이든", "단우", "로운", "서진", "재윤", "민재",
	"성민", "동현", "영수", "상철", "지훈", "병철", "광수", "종호", "기태", "용준",
	"세훈", "수현", "현준", "윤호", "태민", "규민", "찬영", "서윤", "서아", "지아",
	"하윤", "하은", "지유", "수아", "지안", "윤서", "채원", "다은", "예은", "유나",
	"소율", "아린", "나은", "가은", "시은", "예린", "세아", "민서", "지민", "수빈",
	"유진", "은지", "혜진", "소연", "다인", "하린", "채은", "나연", "해인", "다현",
	"선아", "연우", "주아", "은서", "유리", "아영", "정아", "현아", "승아", "경미",
	"온유", "혜린", "재현", "민호", "성훈", "진우", "태준", "승현", "지원", "하람",
	"시현", "도훈", "준서", "예성", "은우", "지환", "동윤", "현서", "서현", "지수",
	"예지", "하영", "수진", "유경", "다영", "세린", "가영", "나윤", "소민",
	"유빈", "지은", "아윤", "예서", "채린", "민지", "민규", "민석", "민우", "민혁",
	"민철", "민기", "민수", "지석", "지성", "지웅", "지혁", "지완", "지명", "지태", "시후",
	"시원", "시온", "시헌", "시율", "서호", "서원", "서빈", "서율", "서인", "서하",
	"도영", "도진", "도율", "도원", "도준", "도경", "도빈", "하진", "하율", "하민",
	"하성", "현석", "현진", "현호", "현규", "현빈", "현성", "태영", "태윤", "태진",
	"태호", "태현", "태건", "승우", "승훈", "승준", "승호", "승원", "승재", "우석",
	"우빈", "우성", "우혁", "정훈", "정호", "정현", "정민", "정빈", "정원", "준영",
];

const INITIALS = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const VOWELS = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
const FINALS = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];

/** Revised Romanization of a Hangul name, syllable by syllable (민수 -> Minsu); anything else is kept as it is. */
export function romanize(name: string): string {
	let out = "";
	for (const ch of name) {
		const code = ch.charCodeAt(0) - 0xac00;
		out += code >= 0 && code <= 11171 ? INITIALS[Math.floor(code / 588)]! + VOWELS[Math.floor((code % 588) / 28)]! + FINALS[code % 28]! : ch;
	}
	return out.charAt(0).toUpperCase() + out.slice(1);
}

/** English names for sessions made from a non-Korean UI: the Korean pool, romanized (민수 -> Minsu), so each name has a twin. */
export const MEMBER_NAMES_EN = MEMBER_NAMES_KO.map(romanize);

/** The pool for a UI language tag: Korean for `ko*`, English for everything else. No tag = Korean. */
export function poolForLang(lang?: string): readonly string[] {
	return lang && !/^ko(?:-|$)/i.test(lang) ? MEMBER_NAMES_EN : MEMBER_NAMES_KO;
}

/** The pool a given name came from (Latin letters = English), so a reopened or forked session stays in its language. */
export const poolOfName = (name: string): readonly string[] => (/^[a-z]/i.test(name) ? MEMBER_NAMES_EN : MEMBER_NAMES_KO);

/** The next free name given the lower-cased names in use: the pool first, then 철수2, 철수3, ... (Cheolsu2, ...) */
export function nextMemberName(taken: ReadonlySet<string>, pool: readonly string[] = MEMBER_NAMES_KO): string {
	const free = pool.find((n) => !taken.has(n.toLowerCase()));
	if (free) return free;
	for (let n = 2; ; n++) if (!taken.has(`${pool[0]}${n}`.toLowerCase())) return `${pool[0]}${n}`;
}

const SUFFIX = /\d+$/;

/**
 * The same member name in another UI language: 민수 <-> Minsu (a numbered 민수2 <-> Minsu2). A name that is not from the
 * pools (or is already in that language) is returned unchanged.
 */
export function nameInLang(name: string, lang?: string): string {
	const base = name.replace(SUFFIX, "");
	const suffix = name.slice(base.length);
	if (poolForLang(lang) === MEMBER_NAMES_EN) return MEMBER_NAMES_KO.includes(base) ? romanize(base) + suffix : name;
	const i = MEMBER_NAMES_EN.findIndex((n) => n.toLowerCase() === base.toLowerCase());
	return i >= 0 ? MEMBER_NAMES_KO[i]! + suffix : name;
}
