// Balance for WoW Forever: the Wrath - Starfire - Starfire loop with Eclipse,
// Insect Swarm and Moonfire up, Nature's Grace haste, Omen of Clarity and
// mana under the five-second rule. Numbers in ./data.ts, builds in
// ./talents.ts; sources in research/druid_forever.md â†’ Balance.
import type { Combat } from '../../engine/combat';
import type { Ability, Outcome, School, Spec, SpecPanel, Unit } from '../../engine/types';
import { MOONKIN_AURA } from '../../engine/raid';
import { BOSS_RULES } from '../common';
import { BALANCE_STATS } from './data';
import { CONTROLS, D, SOURCES, YARD, barkskin, clearcasting, faerieFire, manaPotion, omen, resetState, roll, useClearcasting } from './shared';
import { buildById, buildLabel, buildsFor, summary, talentsFor, type Talents } from './talents';

const T = (c: Combat): Talents => talentsFor(c.options.build, 'balance', c.options.talents);
const RANGE = 30;

// ------------------------------------------------------------------- mana
const moonglow = (c: Combat) => [0, 0.08, 0.17, 0.25][T(c).moonglow];
/** Improved Wrath and Moonglow add up (gs): Wrath 120 -> 30 mana with 5/5 and 3/3. Provisional. */
const wrathMana = (c: Combat) => Math.round(D.wrath.mana * Math.max(0, 1 - 0.1 * T(c).improvedWrath - moonglow(c)));
const balanceMana = (base: number) => (c: Combat) => (clearcasting(c) ? 0 : Math.round(base * (1 - moonglow(c))));
const moonkinMana = (c: Combat) => Math.round(D.moonkinForm.mana * (1 - 0.1 * T(c).naturalShapeshifter));

/** Mana per second: Spirit regen outside the five-second rule (Reflection keeps some while casting), MP5 always. */
function regen(c: Combat): number {
  const spirit = 6.25 + Number(c.options.spirit ?? 123) / 8;
  const mp5 = Number(c.options.mp5 ?? 9) / 5;
  const casting = c.t - c.lastSpend < 5;
  const innervate = !!c.aura(c.player, 'innervate');
  const reflection = [0, 0.17, 0.33, 0.5][T(c).reflection];
  // Innervate: 5 times the Spirit regeneration, all of it while casting.
  const share = innervate ? 1 : casting ? reflection : 1;
  return spirit * (innervate ? D.innervate.regen : 1) * share + mp5;
}

// ----------------------------------------------------------------- spells
const spellPower = (c: Combat) => c.stats.spellPower ?? 0;
const vengeance = (c: Combat) => c.rules.spellCritMultiplier + 0.1 * T(c).vengeance;
/** Moonfury +2 % per point to Arcane and Nature, Naturalist +1 % per point to everything (the engine adds Curse of the Elements). */
function schoolMult(c: Combat, _t: Unit, school: School): number {
  const moonfury = school === 'arcane' || school === 'nature' ? 1 + 0.02 * T(c).moonfury : 1;
  return moonfury * (1 + 0.01 * T(c).naturalist);
}

/** Spell table: miss 17 % minus hit (1 % floor), then crit from spell crit and auras. */
function spellRoll(c: Combat, extraCrit = 0): Outcome {
  if (roll(c, Math.max(1, c.rules.spellMiss - c.totalHit()))) return 'resist';
  return roll(c, c.spellCritChance(extraCrit)) ? 'crit' : 'hit';
}

/** Nature's Grace: a non-periodic spell crit gives +10 % cast speed and -10 % GCD for 3 s. */
function naturesGrace(c: Combat): void {
  if (!T(c).naturesGrace) return;
  const g = D.naturesGrace;
  c.applyAura(c.player, { id: 'naturesGrace', name: "Nature's Grace", icon: 'naturesGrace', duration: g.duration, castHaste: g.haste, gcdMult: g.gcd });
  c.count('naturesGrace');
}

/** A direct damage spell; `delay` is the missile's flight time. Wrath, Starfire and Moonfire lose ~6 % to partial resists. */
function directSpell(c: Combat, t: Unit, id: string, school: School, base: number, opts: { extraCrit?: number; mult?: number; delay?: number } = {}): Outcome {
  const outcome = spellRoll(c, opts.extraCrit);
  if (outcome === 'crit') naturesGrace(c);
  const amount = outcome === 'resist' ? 0
    : Math.round(base * schoolMult(c, t, school) * (opts.mult ?? 1) * D.partialResist * (outcome === 'crit' ? vengeance(c) : 1));
  const land = () => c.deal({ target: t, source: id, outcome, school, amount, white: false, spell: true });
  if (opts.delay) c.schedule(c.t + opts.delay, land); else land();
  return outcome;
}

/** A damage over time spell: ticks can crit and re-read spell power (Forever client flag); Genesis +1 % per point. */
function dot(c: Combat, t: Unit, id: string, name: string, school: School, ticks: number, period: number,
  perTick: (cc: Combat) => number, opts: { extraCrit?: number; mult?: number; partial?: boolean } = {}): void {
  c.applyAura(t, {
    id, name, icon: id, duration: ticks * period, period,
    onTick: (cc) => {
      const crit = roll(cc, cc.spellCritChance(opts.extraCrit));
      const mult = schoolMult(cc, t, school) * (opts.mult ?? 1) * (1 + 0.01 * T(cc).genesis) * (opts.partial ? D.partialResist : 1);
      const amount = Math.round(perTick(cc) * mult * (crit ? vengeance(cc) : 1));
      cc.deal({ target: t, source: id, outcome: crit ? 'crit' : 'hit', school, amount, white: false, periodic: true });
    },
  });
}

/** Rolls Omen of Clarity for a cast of `castTime` seconds (the engine tracks the five-second rule). */
function afterCast(c: Combat, castTime: number): void {
  const moonkin = !!c.aura(c.player, 'moonkinForm');
  // fs: 2 procs per minute by cast time (instants count 1.5 s), doubled in Moonkin Form (5 s cooldown there).
  omen(c, Math.max(1.5, castTime), { mult: moonkin ? 2 : 1, icd: moonkin ? 5 : D.omen.icd });
}

const wrathCast = (c: Combat) => Math.max(0, D.wrath.cast - 0.1 * T(c).improvedWrath - boost(c, 'wrath').cast) / c.castHaste();
const eclipseCharges = (c: Combat) => c.aura(c.player, 'eclipse')?.stacks ?? 0;
const eclipseCut = (c: Combat) => [0, 0.17, 0.33, 0.5][T(c).eclipse];

// ------------------------------------------------------ what-if Eclipse
// Hypothetical Eclipse styles, picked on the main screen: each replaces what
// the Eclipse talent does ('forever' is the beta's). Defaults in data.ts →
// whatIf; the player can change every value (options 'wi.<style>.<key>').
const STYLES = ['forever', 'stackDump', 'twinWrath', 'starfireCd', 'alternating', 'solarFocus', 'lunarFocus', 'none'] as const;
type Style = (typeof STYLES)[number];
const W = D.whatIf;
function style(c: Combat): Style {
  const s = String(c.options.eclipseStyle ?? 'forever') as Style;
  return T(c).eclipse && STYLES.includes(s) ? s : 'none';
}
const stacksOf = (c: Combat, id: string) => c.aura(c.player, id)?.stacks ?? 0;

const DEFAULTS: Record<Style, Record<string, number>> = {
  forever: { perWrath: D.wrath.eclipseCharges, critDouble: 0, maxCharges: D.eclipse.maxCharges, duration: D.eclipse.duration, cast: 0.5, damage: 0, crit: 0 },
  stackDump: W.stackDump, twinWrath: W.twinWrath, starfireCd: W.starfireCd, alternating: W.alternating, solarFocus: W.solarFocus, lunarFocus: W.lunarFocus, none: {},
};
const optionKey = (s: Style, key: string) => `wi.${s}.${key}`;
/** A what-if value: the player's own, or the default. */
function tw(c: Combat, s: Style, key: string): number {
  const v = Number(c.options[optionKey(s, key)]);
  return Number.isFinite(v) ? v : DEFAULTS[s][key];
}

/** Per-fight state: the last Lunar or Solar proc (alternating). */
interface WhatIf { lunarAt: number; solarAt: number; last: 'lunar' | 'solar' | null }
const whatIfs = new WeakMap<Combat, WhatIf>();
const freshWhatIf = (): WhatIf => ({ lunarAt: -Infinity, solarAt: -Infinity, last: null });
function wi(c: Combat): WhatIf {
  let s = whatIfs.get(c);
  if (!s) whatIfs.set(c, (s = freshWhatIf()));
  return s;
}
const lunar = (c: Combat) => !!c.aura(c.player, 'lunarEclipse');
const solar = (c: Combat) => !!c.aura(c.player, 'solarEclipse');

/** What the Eclipse state gives the next Wrath or Starfire: seconds off the cast, % damage, % crit. Read before the cast changes it. */
interface Boost { cast: number; damage: number; crit: number }
const NO_BOOST: Boost = { cast: 0, damage: 0, crit: 0 };
const perStack = (c: Combat, s: Style, n: number, prefix = ''): Boost => {
  const k = (key: string) => tw(c, s, prefix ? prefix + key[0].toUpperCase() + key.slice(1) : key) * n;
  return { cast: k('cast'), damage: k('damage'), crit: k('crit') };
};
function boost(c: Combat, id: 'wrath' | 'starfire'): Boost {
  const s = style(c);
  switch (s) {
    case 'forever': {
      if (id !== 'starfire' || !eclipseCharges(c)) return NO_BOOST;
      // One charge per Starfire; fewer talent points give less (the beta's 0.17 / 0.33 / 0.5 sec).
      const b = perStack(c, s, T(c).eclipse / 3);
      return { ...b, cast: eclipseCut(c) * (tw(c, s, 'cast') / 0.5) };
    }
    case 'stackDump': return id === 'starfire' ? perStack(c, s, eclipseCharges(c)) : NO_BOOST;
    case 'starfireCd': return id === 'starfire' ? perStack(c, s, 1) : NO_BOOST;
    case 'alternating':
      if (id === 'starfire' && lunar(c)) return perStack(c, s, 1, 'lunar');
      if (id === 'wrath' && solar(c)) return perStack(c, s, 1, 'solar');
      return NO_BOOST;
    case 'solarFocus': return id === 'wrath' ? perStack(c, s, stacksOf(c, 'solarFocus')) : NO_BOOST;
    case 'lunarFocus': {
      if (id !== 'starfire') return NO_BOOST;
      const b = perStack(c, s, stacksOf(c, 'lunarFocus'));
      return { ...b, cast: b.cast + tw(c, s, 'baseCast') };
    }
    default: return NO_BOOST;
  }
}

function addStack(c: Combat, s: Style, id: string, name: string, icon: string, n = 1): void {
  c.applyAura(c.player, { id, name, icon, duration: tw(c, s, 'duration'), stacks: Math.min(tw(c, s, 'maxStacks'), stacksOf(c, id) + n) });
}
/** Charges or stacks from a Wrath: doubled on a crit when the toggle is on. */
const wrathStacks = (c: Combat, s: Style, n: number, outcome: Outcome) => (outcome === 'crit' && tw(c, s, 'critDouble') ? 2 * n : n);

const twinCharges = (c: Combat) => stacksOf(c, 'twinWrath');
/** How many bolts the next Wrath fires and the power of each (Starfire empowers Wrath). */
function wrathBolts(c: Combat): { n: number; power: number } {
  if (style(c) !== 'twinWrath' || !twinCharges(c)) return { n: 1, power: 1 };
  return { n: Math.max(1, Math.round(tw(c, 'twinWrath', 'bolts'))), power: tw(c, 'twinWrath', 'power') / 100 };
}

/** Alternating: Lunar after a Wrath crit, Solar after a Starfire crit; own cooldown each, never both at once. */
function procEclipse(c: Combat, which: 'lunar' | 'solar', outcome: Outcome): void {
  const s = wi(c);
  const at = which === 'lunar' ? s.lunarAt : s.solarAt;
  if (outcome !== 'crit' || lunar(c) || solar(c) || c.t - at < tw(c, 'alternating', 'icd') || !roll(c, tw(c, 'alternating', `${which}Chance`))) return;
  if (which === 'lunar') s.lunarAt = c.t; else s.solarAt = c.t;
  s.last = which;
  c.applyAura(c.player, which === 'lunar'
    ? { id: 'lunarEclipse', name: 'Lunar Eclipse', icon: 'starfire', duration: tw(c, 'alternating', 'duration') }
    : { id: 'solarEclipse', name: 'Solar Eclipse', icon: 'wrath', duration: tw(c, 'alternating', 'duration') });
  c.count('eclipses');
}

/** What a cast Wrath does to the Eclipse state. */
function wrathEclipse(c: Combat, outcome: Outcome): void {
  const s = style(c);
  switch (s) {
    case 'forever':
    case 'stackDump': {
      const stacks = Math.min(tw(c, s, 'maxCharges'), eclipseCharges(c) + wrathStacks(c, s, tw(c, s, 'perWrath'), outcome));
      c.applyAura(c.player, { id: 'eclipse', name: 'Eclipse', icon: 'eclipse', duration: tw(c, s, 'duration'), stacks });
      return;
    }
    case 'twinWrath': {
      const a = c.aura(c.player, 'twinWrath');
      c.count('wrathsCast');
      if (!a) return;
      c.count('empoweredWraths');
      if ((a.stacks ?? 1) <= 1) c.removeAura(c.player, 'twinWrath'); else a.stacks = (a.stacks ?? 1) - 1;
      return;
    }
    case 'alternating': procEclipse(c, 'lunar', outcome); return;
    case 'solarFocus': addStack(c, s, 'solarFocus', 'Solar Focus', 'wrath', wrathStacks(c, s, 1, outcome)); return;
    case 'lunarFocus': c.removeAura(c.player, 'lunarFocus'); return;
    default:
  }
}

/** What a cast Starfire does to the Eclipse state. */
function starfireEclipse(c: Combat, outcome: Outcome): void {
  const s = style(c);
  const ec = c.aura(c.player, 'eclipse');
  switch (s) {
    case 'forever':
      if (!ec) return;
      c.count('eclipseStarfires');
      if ((ec.stacks ?? 1) <= 1) c.removeAura(c.player, 'eclipse'); else ec.stacks = (ec.stacks ?? 1) - 1;
      return;
    case 'stackDump':
      if (!ec) return;
      c.count('eclipseStarfires');
      c.count('dumpedCharges', ec.stacks ?? 1);
      c.removeAura(c.player, 'eclipse');
      return;
    case 'twinWrath':
      c.applyAura(c.player, { id: 'twinWrath', name: 'Empowered Wrath', icon: 'wrath', duration: tw(c, s, 'duration'), stacks: Math.min(tw(c, s, 'maxCharges'), twinCharges(c) + tw(c, s, 'perStarfire')) });
      return;
    case 'alternating': procEclipse(c, 'solar', outcome); return;
    case 'solarFocus': c.removeAura(c.player, 'solarFocus'); return;
    case 'lunarFocus': addStack(c, s, 'lunarFocus', 'Lunar Focus', 'starfire'); return;
    default:
  }
}

// ------------------------------------------------------ what-if panel
const STYLE_NAMES: Record<Style, string> = {
  forever: 'Forever beta',
  stackDump: 'Wrath banks charges, one Starfire spends all',
  twinWrath: 'Starfire empowers Wrath (several bolts)',
  starfireCd: 'Starfire on a cooldown, hits harder',
  alternating: 'Lunar / Solar procs (Wrath of the Lich King)',
  solarFocus: 'Mono-spell talent: Wrath only (Solar Focus)',
  lunarFocus: 'Mono-spell talent: Starfire only (Lunar Focus)',
  none: 'No Eclipse',
};
type TweakField = [key: string, label: string, step: number, toggle?: boolean];
const CRIT_DOUBLE: TweakField = ['critDouble', 'A Wrath crit gives double', 1, true];
const TRIO = (what: string): TweakField[] => [
  ['cast', `Cast time, sec faster per ${what}`, 0.1], ['damage', `Damage, % per ${what}`, 1], ['crit', `Crit chance, % per ${what}`, 1],
];
const TWEAKS: Record<Style, { group: string; fields: TweakField[] }[]> = {
  forever: [
    { group: 'Wrath gives', fields: [['perWrath', 'Charges per Wrath', 1], CRIT_DOUBLE, ['maxCharges', 'Max charges', 1], ['duration', 'Duration, sec', 1]] },
    { group: 'Each Starfire spends 1 charge for', fields: TRIO('charge') },
  ],
  stackDump: [
    { group: 'Wrath gives', fields: [['perWrath', 'Charges per Wrath', 1], CRIT_DOUBLE, ['maxCharges', 'Max charges', 1], ['duration', 'Duration, sec', 1]] },
    { group: 'Starfire spends every charge for', fields: TRIO('charge') },
    { group: 'Rotation hint', fields: [['dumpAt', 'Starfire at this many charges', 1]] },
  ],
  twinWrath: [
    { group: 'Starfire gives', fields: [['perStarfire', 'Charges per Starfire', 1], ['maxCharges', 'Max charges', 1], ['duration', 'Duration, sec', 1]] },
    { group: 'Each Wrath spends 1 charge to fire', fields: [['bolts', 'Bolts', 1], ['power', 'Power per bolt, %', 5]] },
  ],
  starfireCd: [
    { group: 'Starfire has a cooldown', fields: [['cooldown', 'Cooldown, sec', 1]] },
    { group: 'Starfire always gets', fields: [['cast', 'Cast time, sec faster', 0.1], ['damage', 'Damage, %', 5], ['crit', 'Crit chance, %', 1]] },
  ],
  alternating: [
    { group: 'Lunar Eclipse (Wrath crit), buffs Starfire', fields: [['lunarChance', 'Chance on a Wrath crit, %', 5], ['lunarCast', 'Cast time, sec faster', 0.1], ['lunarDamage', 'Damage, %', 5], ['lunarCrit', 'Crit chance, %', 5]] },
    { group: 'Solar Eclipse (Starfire crit), buffs Wrath', fields: [['solarChance', 'Chance on a Starfire crit, %', 5], ['solarCast', 'Cast time, sec faster', 0.1], ['solarDamage', 'Damage, %', 5], ['solarCrit', 'Crit chance, %', 5]] },
    { group: 'Both', fields: [['duration', 'Duration, sec', 1], ['icd', 'Cooldown, sec', 1]] },
  ],
  solarFocus: [
    { group: 'Each Wrath gives a stack; a Starfire clears them', fields: [['maxStacks', 'Max stacks', 1], CRIT_DOUBLE, ['duration', 'Duration, sec', 1]] },
    { group: 'Each stack gives Wrath', fields: TRIO('stack') },
  ],
  lunarFocus: [
    { group: 'Starfire always', fields: [['baseCast', 'Cast time, sec faster', 0.1]] },
    { group: 'Each Starfire gives a stack; a Wrath clears them', fields: [['maxStacks', 'Max stacks', 1], ['duration', 'Duration, sec', 1]] },
    { group: 'Each stack gives Starfire', fields: [...TRIO('stack'), ['mana', 'Mana cost, % less per stack', 1]] },
  ],
  none: [],
};

/** The bonus in words: "0.3 sec faster, +10% damage". */
function boostText(b: Boost): string {
  const parts = [b.cast ? `${+b.cast.toFixed(2)} sec faster` : '', b.damage ? `+${+b.damage.toFixed(1)}% damage` : '', b.crit ? `+${+b.crit.toFixed(1)}% crit` : ''].filter(Boolean);
  return parts.join(', ') || 'nothing';
}
function styleText(c: Combat, s: Style = style(c)): string {
  const v = (key: string) => tw(c, s, key);
  const trio = (n = 1, prefix = '') => boostText(perStack(c, s, n, prefix));
  const crit = v('critDouble') ? ' (double on a crit)' : '';
  switch (s) {
    case 'forever': return `Forever beta: each Wrath gives ${v('perWrath')} charges${crit} (max ${v('maxCharges')}, ${v('duration')} sec); each Starfire spends one: ${trio()}.`;
    case 'stackDump': return `What-if: each Wrath banks ${v('perWrath')} charge${crit} (max ${v('maxCharges')}, ${v('duration')} sec); the next Starfire spends them all, per charge: ${trio()}. At ${v('maxCharges')} charges: ${trio(v('maxCharges'))}.`;
    case 'twinWrath': return `What-if: each Starfire gives ${v('perStarfire')} charges (max ${v('maxCharges')}, ${v('duration')} sec); each Wrath spends one to fire ${v('bolts')} bolts at ${v('power')}% power (${Math.round(v('bolts') * v('power'))}% of a Wrath in all), each rolling hit and crit on its own.`;
    case 'starfireCd': return `What-if: Starfire has a ${v('cooldown')} sec cooldown and always gets ${trio()}; Wrath fills the rest.`;
    case 'alternating': return `What-if (Wrath of the Lich King): a Wrath crit has a ${v('lunarChance')}% chance of Lunar Eclipse (Starfire: ${trio(1, 'lunar')}); a Starfire crit has a ${v('solarChance')}% chance of Solar Eclipse (Wrath: ${trio(1, 'solar')}). ${v('duration')} sec each, ${v('icd')} sec cooldown, never both at once.`;
    case 'solarFocus': return `What-if talent, Wrath only: each Wrath gives a stack of Solar Focus${crit} (max ${v('maxStacks')}, ${v('duration')} sec), per stack Wrath gets ${trio()}; at ${v('maxStacks')}: ${trio(v('maxStacks'))}. A Starfire clears it.`;
    case 'lunarFocus': return `What-if talent, Starfire only: Starfire is ${v('baseCast')} sec faster; each Starfire gives a stack of Lunar Focus (max ${v('maxStacks')}, ${v('duration')} sec), per stack: ${trio()} and ${v('mana')}% less mana. A Wrath clears it.`;
    default: return 'No Eclipse.';
  }
}
const HINT_TEXT: Record<Style, string> = {
  forever: 'Wrath, then Starfire while you have a charge (Wrath - Starfire - Starfire).',
  stackDump: 'Wrath until the charges reach the number below, then one Starfire.',
  twinWrath: 'Starfire, then Wrath while you have a charge (Starfire - Wrath - Wrath).',
  starfireCd: 'Starfire whenever it is off cooldown, Wrath in between.',
  alternating: 'Starfire in Lunar, Wrath in Solar; between them, cast the spell that can proc the other Eclipse.',
  solarFocus: 'Wrath only, after the DoTs.',
  lunarFocus: 'Starfire only, Wrath when Starfire is out of reach.',
  none: 'Starfire, Wrath when Starfire is out of reach.',
};

function panel(c: Combat): SpecPanel {
  const s = String(c.options.eclipseStyle ?? 'forever') as Style;
  const known = STYLES.includes(s) ? s : 'forever';
  const fields: SpecPanel['fields'] = [
    { key: 'eclipseStyle', name: 'Eclipse works like', kind: 'choice', value: known, choices: STYLES.map((value) => ({ value, label: STYLE_NAMES[value] })) },
  ];
  for (const g of TWEAKS[known]) {
    g.fields.forEach(([key, name, step, toggle], i) => fields.push({ key: optionKey(known, key), name, kind: toggle ? 'toggle' : 'number', step, min: 0, value: tw(c, known, key), group: i === 0 ? g.group : undefined }));
  }
  fields.push({
    key: 'filler', name: 'Rotation hint filler', kind: 'choice', value: String(c.options.filler ?? 'priority'), group: 'Practice',
    choices: [{ value: 'priority', label: 'Best for this Eclipse' }, { value: 'wrath', label: 'Wrath only' }, { value: 'starfire', label: 'Starfire only' }],
  });
  return {
    title: 'What-if Eclipse',
    text: [
      T(c).eclipse ? styleText(c, known) : 'Your talents have no Eclipse: take Eclipse 3/3 to try these.',
      `Hint: ${HINT_TEXT[known]}`,
    ],
    fields,
    resetKeys: Object.keys(DEFAULTS[known]).map((k) => optionKey(known, k)),
  };
}

const starfireCast = (c: Combat) => Math.max(0, D.starfire.cast - 0.1 * T(c).improvedStarfire - boost(c, 'starfire').cast) / c.castHaste();
const starfireMana = (c: Combat) => Math.round(balanceMana(D.starfire.mana)(c) * (style(c) === 'lunarFocus' ? Math.max(0, 1 - tw(c, 'lunarFocus', 'mana') / 100 * stacksOf(c, 'lunarFocus')) : 1));
const splendor = (c: Combat) => T(c).naturesSplendor;
const improvedMoonfire = (c: Combat) => T(c).improvedMoonfire;

const spell = (a: Omit<Ability, 'gcd' | 'target' | 'range' | 'hastedGcd' | 'noAutoAttack'>): Ability => ({
  gcd: D.spellGcd, target: 'enemy', range: RANGE, hastedGcd: true, noAutoAttack: true, ...a,
});

// ------------------------------------------------------------- abilities
const abilities: Ability[] = [
  spell({
    id: 'wrath', name: 'Wrath', icon: 'wrath', animation: 'cast',
    projectile: { color: 0x8ef05a, speed: 20, style: 'nature' },
    cost: wrathMana,
    castTime: wrathCast,
    description: (c) => `A ${wrathCast(c).toFixed(2)} sec cast: ${D.wrath.min}-${D.wrath.max} Nature damage plus ${Math.round(D.wrath.coeff * 100)}% of spell power. Never uses Clearcasting. Eclipse: ${styleText(c)}`,
    use: (c, t) => {
      const u = t!;
      const w = D.wrath;
      const b = boost(c, 'wrath');
      const bolts = wrathBolts(c);
      // Several bolts (Starfire empowers Wrath) each roll on their own; a crit on any counts for the procs.
      let outcome: Outcome = 'resist';
      for (let i = 0; i < bolts.n; i++) {
        const base = w.min + c.random() * (w.max - w.min) + w.coeff * spellPower(c);
        const o = directSpell(c, u, 'wrath', 'nature', base, { delay: c.distance(u) / (20 * YARD) + 0.15 * i, mult: (1 + b.damage / 100) * bolts.power, extraCrit: b.crit });
        if (i === 0 || o === 'crit') outcome = o;
      }
      wrathEclipse(c, outcome);
      afterCast(c, wrathCast(c));
    },
  }),
  spell({
    id: 'starfire', name: 'Starfire', icon: 'starfire', animation: 'cast',
    projectile: { color: 0xe9a8ff, fromSky: true, style: 'arcane' },
    cost: starfireMana,
    castTime: starfireCast,
    cooldown: (c) => (style(c) === 'starfireCd' ? tw(c, 'starfireCd', 'cooldown') : 0),
    highlight: (c) => eclipseCharges(c) > 0 || lunar(c),
    description: (c) => `A ${starfireCast(c).toFixed(2)} sec cast: ${D.starfire.min}-${D.starfire.max} Arcane damage plus ${D.starfire.coeff * 100}% of spell power. Eclipse: ${styleText(c)}`,
    use: (c, t) => {
      const s = D.starfire;
      const cast = starfireCast(c);
      const b = boost(c, 'starfire');
      useClearcasting(c);
      c.count('starfires');
      const outcome = directSpell(c, t!, 'starfire', 'arcane', s.min + c.random() * (s.max - s.min) + s.coeff * spellPower(c), { mult: 1 + b.damage / 100, extraCrit: b.crit });
      starfireEclipse(c, outcome);
      afterCast(c, cast);
    },
  }),
  spell({
    id: 'moonfire', name: 'Moonfire', icon: 'moonfire', animation: 'cast',
    projectile: { color: 0x9fd8ff, fromSky: true, style: 'frost' },
    cost: balanceMana(D.moonfire.mana),
    description: (c) => `${D.moonfire.min}-${D.moonfire.max} Arcane damage, then ${D.moonfire.tick} every ${D.moonfire.period} sec for ${(D.moonfire.ticks + splendor(c)) * D.moonfire.period} sec, both with spell power. The ticks can crit.`,
    use: (c, t) => {
      const u = t!;
      const m = D.moonfire;
      useClearcasting(c);
      const imf = { extraCrit: 5 * improvedMoonfire(c), mult: 1 + 0.05 * improvedMoonfire(c) };
      const outcome = directSpell(c, u, 'moonfire', 'arcane', m.min + c.random() * (m.max - m.min) + m.coeff * spellPower(c), imf);
      if (outcome !== 'resist') dot(c, u, 'moonfire', 'Moonfire', 'arcane', m.ticks + splendor(c), m.period, (cc) => m.tick + m.tickCoeff * spellPower(cc), { ...imf, partial: true });
      afterCast(c, 0);
    },
  }),
  spell({
    id: 'insectSwarm', name: 'Insect Swarm', icon: 'insectSwarm', animation: 'cast',
    cost: balanceMana(D.insectSwarm.mana),
    requirements: (c) => (T(c).insectSwarm ? null : 'Requires the Insect Swarm talent'),
    usable: (c) => T(c).insectSwarm > 0,
    description: (c) => `${D.insectSwarm.tick} Nature damage plus spell power every ${D.insectSwarm.period} sec for ${(D.insectSwarm.ticks + splendor(c)) * D.insectSwarm.period} sec; the target's hit chance drops by 2%. All or nothing: no partial resists.`,
    use: (c, t) => {
      const u = t!;
      const s = D.insectSwarm;
      useClearcasting(c);
      if (roll(c, Math.max(1, c.rules.spellMiss - c.totalHit()))) {
        c.deal({ target: u, source: 'insectSwarm', outcome: 'resist', school: 'nature', amount: 0, white: false });
      } else {
        dot(c, u, 'insectSwarm', 'Insect Swarm', 'nature', s.ticks + splendor(c), s.period, (cc) => s.tick + s.tickCoeff * spellPower(cc));
      }
      afterCast(c, 0);
    },
  }),
  faerieFire({ gcd: D.spellGcd, hasted: true, cost: () => D.faerieFire.mana }),
  {
    id: 'innervate', name: 'Innervate', icon: 'innervate', gcd: D.spellGcd, target: 'self', hastedGcd: true,
    animation: 'cast',
    cost: () => D.innervate.mana, cooldown: D.innervate.cooldown,
    description: () => `For ${D.innervate.duration} sec your Spirit regeneration is 5 times faster and continues fully while casting.`,
    use: (c) => {
      c.applyAura(c.player, { id: 'innervate', name: 'Innervate', icon: 'innervate', duration: D.innervate.duration });
      afterCast(c, 0);
    },
  },
  {
    id: 'moonkinForm', name: 'Moonkin Form', icon: 'moonkinForm', gcd: D.spellGcd, target: 'self',
    animation: 'cast',
    cost: (c) => (c.aura(c.player, 'moonkinForm') ? 0 : moonkinMana(c)),
    requirements: (c) => (T(c).moonkinForm ? null : 'Requires the Moonkin Form talent'),
    usable: (c) => T(c).moonkinForm > 0,
    highlight: (c) => !!c.aura(c.player, 'moonkinForm'),
    description: (c) => `Moonkin Aura: 3% spell crit for the raid (stacks with Leader of the Pack since Oct 15); Omen of Clarity procs twice as often. ${moonkinMana(c)} mana. Press again to leave the form.`,
    use: (c) => {
      if (c.aura(c.player, 'moonkinForm')) { leaveMoonkin(c); return; }
      enterMoonkin(c);
    },
  },
  barkskin(D.spellGcd),
  manaPotion,
];

function enterMoonkin(c: Combat): void {
  c.applyAura(c.player, { id: 'moonkinForm', name: 'Moonkin Form', icon: 'moonkinForm', duration: Infinity });
  c.applyAura(c.player, MOONKIN_AURA);
}
function leaveMoonkin(c: Combat): void {
  c.removeAura(c.player, 'moonkinForm');
  // Another druid's Moonkin Aura in the raid stays.
  if (!c.raid.has('moonkinAura')) c.removeAura(c.player, 'moonkinAura');
}

// ----------------------------------------------------------------- setup
function prepare(c: Combat): void {
  const t = T(c);
  const p = c.player;
  resetState(c);
  p.maxResource = Math.max(1, Number(c.options.mana ?? 4024));
  p.regenPerSecond = 0;
  c.manaLocked = !!c.options.lockMana;
  c.mod.spellCrit = 2 * t.naturesMajesty;
  c.mod.hit = 2 * t.naturesReach;
  // Moonkin Form before the pull.
  if (t.moonkinForm) enterMoonkin(c);
  c.trackedTargetAuras.push('moonfire', 'insectSwarm');
  c.trackedAuras.push('naturesGrace', 'lunarEclipse', 'solarEclipse', 'solarFocus', 'lunarFocus');
  whatIfs.set(c, freshWhatIf());
}

// ------------------------------------------------------------- rotation
/** gs's ranked moonkin list (research/druid_forever.md â†’ Balance). */
function suggest(c: Combat): string | null {
  const t = c.target;
  if (!t || t.health <= 0) return null;
  const p = c.player;
  const tl = T(c);
  const ready = (id: string) => c.cooldownLeft(id).left === 0;
  if (tl.moonkinForm && !c.aura(p, 'moonkinForm')) return 'moonkinForm';
  if (!c.manaLocked && p.inCombat) {
    if (p.resource <= 500 && ready('innervate')) return 'innervate';
    if (p.resource <= p.maxResource - D.manaPotion.max && p.resource <= 1500 && ready('manaPotion')) return 'manaPotion';
  }
  // Short on mana: skip what you cannot pay for; Wrath (30 mana) keeps you casting.
  const afford = (id: string) => c.cost(c.ability(id)!) <= p.resource;
  if (tl.insectSwarm && !c.aura(t, 'insectSwarm') && afford('insectSwarm')) return 'insectSwarm';
  if (!c.aura(t, 'moonfire') && afford('moonfire')) return 'moonfire';
  const starfire = afford('starfire') && ready('starfire') ? 'starfire' : 'wrath';
  // A forced filler, to compare one-spell rotations with the priority.
  const filler = String(c.options.filler ?? 'priority');
  if (filler === 'wrath') return 'wrath';
  if (filler === 'starfire') return starfire;
  switch (style(c)) {
    case 'forever': return eclipseCharges(c) >= 1 ? starfire : 'wrath';
    case 'stackDump': return eclipseCharges(c) >= Math.min(tw(c, 'stackDump', 'maxCharges'), tw(c, 'stackDump', 'dumpAt')) ? starfire : 'wrath';
    case 'alternating':
      if (lunar(c)) return starfire;
      if (solar(c)) return 'wrath';
      // Between Eclipses: fish for the other one.
      return wi(c).last === 'lunar' ? starfire : 'wrath';
    case 'twinWrath': return twinCharges(c) >= 1 ? 'wrath' : starfire;
    case 'starfireCd': return starfire;
    case 'solarFocus': return 'wrath';
    default: return starfire;
  }
}

// ------------------------------------------------------- practice helpers
function chances(c: Combat): { title: string; rows: [string, string][] }[] {
  const tl = T(c);
  const pct = (n: number) => `${Math.max(0, n).toFixed(1)}%`;
  const miss = Math.max(1, c.rules.spellMiss - c.totalHit());
  const moonkin = !!c.aura(c.player, 'moonkinForm');
  const omenAt = (cast: number) => pct(((D.omen.ppm * Math.max(1.5, cast)) / 60) * 100 * (moonkin ? 2 : 1));
  const procs: [string, string][] = [
    ['Clearcasting: next Starfire, Moonfire or Insect Swarm free', `Wrath ${omenAt(wrathCast(c))} / Starfire ${omenAt(starfireCast(c))} / instants ${omenAt(1.5)} per cast${moonkin ? ' (doubled in Moonkin Form)' : ''}; provisional`],
  ];
  if (tl.naturesGrace) procs.push(["Nature's Grace: +10% cast speed, -10% GCD for 3 s", `on every direct spell crit (${pct(c.spellCritChance())})`]);
  if (c.raid.has('judgementOfWisdom')) procs.push(['Judgement of Wisdom: +59 mana', '50% per landed direct spell']);
  return [
    {
      title: 'Your spells',
      rows: [
        ['Miss (17% minus hit, 1% floor)', pct(miss)],
        ['Crit (Moonfire +' + 5 * tl.improvedMoonfire + '%)', pct(c.spellCritChance())],
        ['Crit damage', `${vengeance(c).toFixed(1)}x`],
        ['Partial resists on Wrath, Starfire and Moonfire', `-${Math.round((1 - D.partialResist) * 100)}% on average`],
      ],
    },
    { title: 'Procs', rows: procs },
    {
      title: 'Rhythm',
      rows: [
        ['Wrath cast / Starfire cast (with Eclipse)', `${wrathCast(c).toFixed(2)} s / ${((D.starfire.cast - 0.1 * tl.improvedStarfire) / c.castHaste()).toFixed(2)} s (${((D.starfire.cast - 0.1 * tl.improvedStarfire - eclipseCut(c)) / c.castHaste()).toFixed(2)} s)`],
        ['Global cooldown', '1.5 s, shorter with casting haste (1.0 s floor)'],
        ['Eclipse', tl.eclipse ? styleText(c) : 'not talented'],
        ['Mana: Wrath / Starfire / Moonfire / Insect Swarm', `${wrathMana(c)} / ${Math.round(D.starfire.mana * (1 - moonglow(c)))} / ${Math.round(D.moonfire.mana * (1 - moonglow(c)))} / ${Math.round(D.insectSwarm.mana * (1 - moonglow(c)))}`],
        ['Mana regeneration now', `${regen(c).toFixed(1)} per second`],
      ],
    },
  ];
}

function review(c: Combat): { label: string; value: string; good?: boolean }[] {
  const k = c.counters;
  const time = k.combatTime ?? 0;
  if (time < 1) return [];
  const pctOf = (n: number) => `${Math.round(n * 100)}%`;
  const uptime = (key: string) => (k[key] ?? 0) / time;
  const starfires = k.starfires ?? 0;
  const rows: { label: string; value: string; good?: boolean }[] = [
    { label: 'Moonfire uptime', value: pctOf(uptime('uptime:target:moonfire')), good: uptime('uptime:target:moonfire') >= 0.85 },
  ];
  if (T(c).insectSwarm) rows.push({ label: 'Insect Swarm uptime', value: pctOf(uptime('uptime:target:insectSwarm')), good: uptime('uptime:target:insectSwarm') >= 0.85 });
  const st = style(c);
  if (st === 'forever') rows.push({ label: 'Starfires with Eclipse', value: starfires ? `${k.eclipseStarfires ?? 0} of ${starfires}` : '-', good: starfires === 0 || (k.eclipseStarfires ?? 0) / starfires >= 0.9 });
  if (st === 'twinWrath') rows.push({ label: 'Empowered Wraths', value: k.wrathsCast ? `${k.empoweredWraths ?? 0} of ${k.wrathsCast}` : '-' });
  if (st === 'stackDump') rows.push({ label: 'Charges per Starfire', value: k.eclipseStarfires ? ((k.dumpedCharges ?? 0) / k.eclipseStarfires).toFixed(1) : '-' });
  if (st === 'alternating') {
    rows.push({ label: 'Lunar / Solar Eclipse uptime', value: `${pctOf(uptime('uptime:lunarEclipse'))} / ${pctOf(uptime('uptime:solarEclipse'))}` });
  }
  if (st === 'solarFocus' || st === 'lunarFocus') rows.push({ label: `${st === 'solarFocus' ? 'Solar' : 'Lunar'} Focus uptime`, value: pctOf(uptime(`uptime:${st}`)) });
  if (T(c).naturesGrace) rows.push({ label: "Nature's Grace uptime", value: pctOf(uptime('uptime:naturesGrace')) });
  rows.push({ label: 'Clearcasting procs / used', value: `${k.clearcasting ?? 0} / ${k.clearcastingUsed ?? 0}` });
  if (!c.manaLocked) {
    if (c.raid.has('judgementOfWisdom')) rows.push({ label: 'Mana from Judgement of Wisdom', value: `+${Math.round(k.manaOnHit ?? 0)}` });
    rows.push({ label: 'Time without mana for Starfire', value: `${Math.round(k.lowMana ?? 0)} s (${pctOf((k.lowMana ?? 0) / time)})`, good: (k.lowMana ?? 0) / time < 0.1 });
  }
  return rows;
}

export const druidBalance: Spec = {
  id: 'druid-balance',
  className: 'Druid',
  specName: 'Balance',
  resource: 'mana',
  abilities,
  stats: BALANCE_STATS,
  rules: BOSS_RULES,
  builds: buildsFor('balance').map((b) => ({ id: b.id, label: buildLabel(b), name: b.name, source: 'gunba/wow-forever-sim', talentString: b.talentString, stats: b.stats, bar: b.bar, trees: summary(talentsFor(b.id, 'balance')) })),
  defaultOptions: { build: 'moonkin', mana: 4024, spirit: 123, mp5: 9, lockMana: false, eclipseStyle: 'forever', filler: 'priority' },
  // Running out of mana is part of Balance: play with the raid's mana buffs on.
  defaultRaid: ['judgementOfWisdom', 'blessingOfWisdom', 'manaSpring'],
  prefsRevision: 2,
  lowMana: (c) => Math.round(D.starfire.mana * (1 - moonglow(c))),
  options: [
    { key: 'lockMana', name: 'Lock your mana (spells cost nothing)', kind: 'toggle' },
    { key: 'mana', name: 'Mana pool', kind: 'number', step: 100 },
    { key: 'spirit', name: 'Spirit (regeneration outside the five-second rule)', kind: 'number', step: 1 },
    { key: 'mp5', name: 'Mana per 5 sec from gear', kind: 'number', step: 1 },
  ],
  sheet: { attackPower: false, crit: false, spellCrit: 'Spell crit (gear + Intellect)', spellPower: 'Spell power', mainHand: false, offHand: false },
  regen,
  bar: buildById('moonkin', 'balance').bar,
  welcome: 'Welcome to the Balance practice yard. Keep Insect Swarm and Moonfire up, then loop Wrath - Starfire - Starfire: each Wrath gives two Eclipse charges that make Starfire faster. Mana runs out, as it does in Forever: Judgement of Wisdom, Blessing of Wisdom and Mana Spring Totem are on, and Innervate and Major Mana Potions are on your bar.',
  help: `${CONTROLS}
    Spells have a cast bar; moving interrupts it. The global cooldown is 1.5 sec and shrinks with casting haste down to 1.0 sec.
    Wrath (1.5 sec with Improved Wrath) gives two Eclipse charges; each one takes 0.5 sec off a Starfire (3.0 -> 2.5 sec). A spell crit gives Nature's Grace: 10% faster casts and a 10% shorter GCD for 3 sec.
    Moonfire and Insect Swarm ticks can crit and use your spell power each tick. Clearcasting makes your next Starfire, Moonfire or Insect Swarm free, never Wrath; Moonkin Form doubles its chance.
    Mana: Spirit regeneration stops for 5 sec after you spend mana (Reflection keeps half of it while casting), MP5 always counts. Judgement of Wisdom on the dummy gives mana back on your direct spells; Blessing of Wisdom and Mana Spring Totem add 8 and 5 mana per second (all three are on by default under Raid buffs and debuffs); Innervate and Major Mana Potions do the rest. You can lock your mana in Settings.
    This is a practice tool: hit, crit and proc chances follow WoW Forever; damage numbers are an approximation.`,
  look: { clothColor: 0x2f5a3a, leatherColor: 0x3d3326, hood: false, robe: true },
  sources: SOURCES,
  prepare,
  suggest,
  chances,
  review,
  panel,
};
