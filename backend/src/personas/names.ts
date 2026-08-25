/**
 * Name pools, by country and gender.
 *
 * ---------------------------------------------------------------------------
 * WHY POOLS RATHER THAN A GENERATOR
 * ---------------------------------------------------------------------------
 * A name has to survive one test: a stranger reading it must not pause. Names
 * assembled from syllables fail that constantly, and the failure is invisible
 * to whoever wrote the generator and obvious to somebody who lives where the
 * name is supposed to come from.
 *
 * So these are lists, and short ones. A pool of twenty per country and gender
 * is enough: the surface is regenerated every conversation, so what matters is
 * that a *pair* of (name, age, country) rarely repeats, and the age range
 * multiplies the pool by twenty or more on its own.
 *
 * ---------------------------------------------------------------------------
 * FIRST NAMES ONLY, AND WHY THAT IS NOT LAZINESS
 * ---------------------------------------------------------------------------
 * The declared name is a display name shown to a stranger. A surname adds
 * nothing a stranger can use and makes the persona look like a filled-in form
 * rather than somebody who typed what they wanted to be called. Real users of
 * this product overwhelmingly type a first name, a nickname or nothing at all,
 * and a population of personas with tidy full names would be conspicuous.
 *
 * A minority of surfaces get no name at all, for the same reason — see
 * `NO_NAME_CHANCE` in `surface.ts`.
 *
 * ---------------------------------------------------------------------------
 * COVERAGE IS DELIBERATELY NARROW
 * ---------------------------------------------------------------------------
 * Only countries a character actually declares are listed. `assertNamePools`
 * fails at load if a character names a country with no pool, so the two cannot
 * drift apart. Adding a country to a character means adding its names here, and
 * that ordering is intentional: it is a prompt to find out whether the names
 * are right rather than to guess.
 */

import type { CountryCode, Gender } from '../protocol/types';

/** Female, male, and names comfortable on anyone from that country. */
export interface CountryNames {
  readonly female: readonly string[];
  readonly male: readonly string[];
  readonly neutral: readonly string[];
}

export const NAME_POOLS: Partial<Record<CountryCode, CountryNames>> = {
  IN: {
    female: [
      'Ananya', 'Meera', 'Divya', 'Kavya', 'Sneha', 'Ritika', 'Aisha', 'Priya',
      'Tanvi', 'Neha', 'Shreya', 'Pooja', 'Ishita', 'Anjali', 'Nandini', 'Swara',
    ],
    male: [
      'Arjun', 'Rohan', 'Karan', 'Aditya', 'Vikram', 'Nikhil', 'Rahul', 'Siddharth',
      'Manav', 'Dev', 'Kabir', 'Ishaan', 'Varun', 'Tarun', 'Aryan', 'Harsh',
    ],
    neutral: ['Kiran', 'Jyoti', 'Anmol', 'Sahil', 'Noor', 'Aman'],
  },
  GB: {
    female: [
      'Ellie', 'Sophie', 'Chloe', 'Megan', 'Hannah', 'Freya', 'Amber', 'Niamh',
      'Jess', 'Lucy', 'Erin', 'Molly', 'Beth', 'Kayleigh', 'Rosie', 'Imogen',
    ],
    male: [
      'Callum', 'Liam', 'Jamie', 'Ben', 'Ollie', 'Josh', 'Ewan', 'Harry',
      'Dan', 'Reece', 'Alfie', 'Kai', 'Rhys', 'Toby', 'Louis', 'Finn',
    ],
    neutral: ['Alex', 'Sam', 'Charlie', 'Robin', 'Jules', 'Frankie'],
  },
  US: {
    female: [
      'Maddie', 'Riley', 'Sydney', 'Bailey', 'Paige', 'Kendall', 'Reese', 'Harper',
      'Nadia', 'Jenna', 'Marisol', 'Camille', 'Taryn', 'Devon', 'Simone', 'Aaliyah',
    ],
    male: [
      'Tyler', 'Cody', 'Marcus', 'Devin', 'Miles', 'Trey', 'Bryce', 'Xavier',
      'Jonah', 'Elias', 'Damon', 'Wes', 'Kellan', 'Andre', 'Zeke', 'Corey',
    ],
    neutral: ['Jordan', 'Casey', 'Rowan', 'Emerson', 'Quinn', 'Avery'],
  },
  CA: {
    female: ['Chloé', 'Maeve', 'Nora', 'Camille', 'Sadie', 'Elowen', 'Josée', 'Tessa'],
    male: ['Liam', 'Émile', 'Owen', 'Declan', 'Mathis', 'Beau', 'Cody', 'Nolan'],
    neutral: ['Jules', 'Sasha', 'River', 'Dana'],
  },
  AU: {
    female: ['Tayla', 'Bindi', 'Skye', 'Jorja', 'Indi', 'Bree', 'Millie', 'Sienna'],
    male: ['Blake', 'Jarrah', 'Cooper', 'Hamish', 'Kai', 'Darcy', 'Lachie', 'Angus'],
    neutral: ['Bailey', 'Jaz', 'Marley', 'Kit'],
  },
  DE: {
    female: ['Lena', 'Annika', 'Jule', 'Mira', 'Svenja', 'Katharina', 'Elif', 'Pia'],
    male: ['Jonas', 'Finn', 'Lukas', 'Tobias', 'Mert', 'Niklas', 'Emre', 'Jannik'],
    neutral: ['Kim', 'Toni', 'Sascha', 'Robin'],
  },
  BR: {
    female: ['Larissa', 'Bruna', 'Camila', 'Juliana', 'Thaís', 'Rafaela', 'Bia', 'Manu'],
    male: ['Thiago', 'Rafa', 'Caio', 'Vinícius', 'Gustavo', 'Léo', 'Bruno', 'Davi'],
    neutral: ['Ariel', 'Dani', 'Alex', 'Nil'],
  },
  PH: {
    female: ['Bea', 'Kaye', 'Andrea', 'Alyssa', 'Trisha', 'Nicole', 'Jhen', 'Mika'],
    male: ['Paolo', 'JM', 'Miguel', 'Kiko', 'Rico', 'Jerome', 'Carlo', 'Enzo'],
    neutral: ['Kim', 'Jai', 'Chris', 'Ash'],
  },
  ID: {
    female: ['Putri', 'Dinda', 'Ayu', 'Salsa', 'Nabila', 'Intan', 'Rania', 'Sari'],
    male: ['Rizky', 'Bagus', 'Dimas', 'Fajar', 'Adit', 'Yoga', 'Reza', 'Bayu'],
    neutral: ['Andra', 'Eka', 'Cinta', 'Nanda'],
  },
  NG: {
    female: ['Chidinma', 'Zainab', 'Ada', 'Temi', 'Ify', 'Amaka', 'Halima', 'Bisi'],
    male: ['Emeka', 'Tunde', 'Chuka', 'Femi', 'Musa', 'Obi', 'Segun', 'Kelechi'],
    neutral: ['Ife', 'Sade', 'Ola', 'Zuri'],
  },
  ZA: {
    female: ['Lerato', 'Naledi', 'Amahle', 'Zanele', 'Kirsten', 'Thandi', 'Nomsa', 'Robyn'],
    male: ['Sipho', 'Thabo', 'Ruan', 'Lwazi', 'Dumi', 'Pieter', 'Kagiso', 'Ayanda'],
    neutral: ['Lesedi', 'Bo', 'Sam', 'Reneilwe'],
  },
  JP: {
    female: ['Yui', 'Haruka', 'Mio', 'Rin', 'Aoi', 'Nanami', 'Saki', 'Hina'],
    male: ['Sota', 'Ren', 'Haruto', 'Yuto', 'Kaito', 'Riku', 'Daiki', 'Takumi'],
    neutral: ['Hikaru', 'Aki', 'Makoto', 'Kaoru'],
  },
};

/**
 * The pool a surface draws from for a given country and gender.
 *
 * `nonbinary` and `other` draw from `neutral` rather than from a gendered list.
 * Picking a gendered name for a non-binary surface is the kind of detail that
 * reads as carelessness to exactly the person it describes, and the neutral
 * pool exists so the answer is a real name rather than a compromise.
 */
export function poolFor(country: CountryCode, gender: Gender | null): readonly string[] {
  const pool = NAME_POOLS[country];
  if (pool === undefined) {
    throw new Error(`persona names: no pool for country ${country}`);
  }
  switch (gender) {
    case 'female':
      return [...pool.female, ...pool.neutral];
    case 'male':
      return [...pool.male, ...pool.neutral];
    case 'nonbinary':
    case 'other':
      return pool.neutral;
    case null:
      return [...pool.female, ...pool.male, ...pool.neutral];
    default:
      return pool.neutral;
  }
}

/**
 * Fail at load if any character declares a country with no names behind it.
 *
 * Without this the failure surfaces at generation time, inside a running
 * process, for one persona and one country combination — which is to say
 * rarely, in production, and looking like a fluke.
 */
export function assertNamePools(countries: Iterable<CountryCode>): void {
  const missing = [...new Set(countries)].filter((c) => NAME_POOLS[c] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `persona names: characters declare countries with no name pool: ${missing.join(', ')}. ` +
        'Add them to NAME_POOLS rather than removing them from the character.',
    );
  }
}
