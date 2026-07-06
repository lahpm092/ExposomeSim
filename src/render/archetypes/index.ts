// =============================================================================
// archetypes/index.ts — imports every archetype module ONCE for its side-effect
// registration (registerArchetype) and re-exports the contract, so consumers
// can `import { getArchetype } from './archetypes'` and find the registry full.
// =============================================================================
import './bakery';
import './butcher';
import './greengrocer';
import './dairy';
import './furniture';
import './tailor';
import './market2';
import './workshop';
import './conyard';

export * from './contract';
export {
  breadLoaves, produceCrate, clothBolts, milkCans, plankStack,
  chairPiece, hangingCuts, shelfModule, TONE,
} from './goodsassets';
