// What-if Balance: plays every Eclipse style (data.ts → whatIf) with the
// priority hint and with one-spell fillers, and prints the average DPS,
// with real mana and with mana locked. Usage: npm run whatif
import { Combat } from '../src/engine/combat';
import type { Unit } from '../src/engine/types';
import { druidBalance } from '../src/specs/druid';

const SECONDS = 300;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

function play(options: Record<string, number | boolean | string>, seed: number) {
  let s = seed * 7919;
  const c = new Combat(druidBalance, { ...(druidBalance.defaultOptions ?? {}), ...options });
  c.random = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  c.stats = structuredClone(druidBalance.stats);
  c.raid = new Set(druidBalance.defaultRaid ?? []);
  const dummy: Unit = { id: 0, name: 'Dummy', level: 63, health: 1e9, maxHealth: 1e9, armor: 3731, auras: new Map(), x: 0, z: 0, facing: 0, radius: 0.5 };
  c.targets = [dummy];
  c.target = dummy;
  c.player.x = 0; c.player.z = -2; c.player.facing = 0;
  c.reset();
  for (let t = 0; t < SECONDS; t += 0.05) {
    const id = c.casting ? null : druidBalance.suggest?.(c);
    if (id) c.use(id);
    c.update(0.05);
  }
  return c;
}

const avg = (options: Record<string, number | boolean | string>) =>
  SEEDS.reduce((a, seed) => a + play(options, seed).dps(), 0) / SEEDS.length;

const STYLES = ['forever', 'stackDump', 'twinWrath', 'alternating', 'solarFocus', 'lunarFocus', 'none'];
const FILLERS = ['priority', 'wrath', 'starfire'];

console.log(`Moonkin 38/0/13, ${SECONDS / 60} min, ${SEEDS.length} seeds. DPS with real mana (locked mana)`);
console.log(`  ${'Eclipse style'.padEnd(14)}${FILLERS.map((f) => f.padStart(16)).join('')}`);
for (const eclipseStyle of STYLES) {
  const cells = FILLERS.map((filler) => {
    const real = avg({ eclipseStyle, filler });
    const locked = avg({ eclipseStyle, filler, lockMana: true });
    return `${real.toFixed(0)} (${locked.toFixed(0)})`.padStart(16);
  });
  console.log(`  ${eclipseStyle.padEnd(14)}${cells.join('')}`);
}

const show = (label: string, options: Record<string, number | boolean | string>) =>
  console.log(`  ${label.padEnd(30)}${avg(options).toFixed(0).padStart(5)} (${avg({ ...options, lockMana: true }).toFixed(0)})`);
const dump = (o: Record<string, number>) => ({ eclipseStyle: 'stackDump', ...Object.fromEntries(Object.entries(o).map(([k, v]) => [`wi.stackDump.${k}`, v])) });
console.log('Banked charges: Starfire at N charges (default: 0.3 sec and +10% damage per charge)');
for (let n = 1; n <= 5; n++) show(`N=${n}`, dump({ dumpAt: n }));
console.log('Banked charges: what each charge gives Starfire (Starfire at 3)');
show('0.3 sec faster only', dump({ damage: 0 }));
show('+10% damage only', dump({ cast: 0 }));
show('+10% crit only', dump({ cast: 0, damage: 0, crit: 10 }));
show('0.3 sec, +10% damage, +5% crit', dump({ crit: 5 }));
console.log('A Wrath crit gives double charges or stacks');
show('Forever beta', { eclipseStyle: 'forever', 'wi.forever.critDouble': 1 });
show('Banked charges, Starfire at 3', dump({ critDouble: 1 }));
show('Wrath-only talent', { eclipseStyle: 'solarFocus', 'wi.solarFocus.critDouble': 1 });
console.log('Starfire empowers Wrath: bolts x power per bolt');
for (const [bolts, power] of [[2, 60], [2, 50], [2, 70], [3, 40]]) {
  show(`${bolts} bolts at ${power}%`, { eclipseStyle: 'twinWrath', 'wi.twinWrath.bolts': bolts, 'wi.twinWrath.power': power });
}
