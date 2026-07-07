// =============================================================================
// ExposomeSim — GOV module surface. The world imports GovField and the types;
// the parts stay individually reachable (readonly fields on the facade) for
// the observatory and the render layer, the causal-field discipline.
// =============================================================================

export { GovField } from './govsim';
export type { GovFieldOpts } from './govsim';
export { OpinionField, categoryScores, grievanceTarget } from './opinion';
export { Movement } from './movement';
export { CharterProcess } from './charter';
export { GovTreasury } from './treasury';
export { Officials, GOV_FIRM_ID, GOV_FIRM_NAME } from './officials';
export { GovHistory, GOV_HIST_FIELDS, STATE_CODE } from './history';
export type { GovHistField } from './history';
export { CIVIC_SEEDS, civicSeedPlan } from './seeds';
export type { CivicSeed } from './seeds';
export { CIVIC_CATEGORIES, civicTopic, isCivicTopic, ALLOWED_TRANSITIONS } from './types';
export type {
  CivicCategory, GovMacroSlice, TierAMaterialRow, CivicPoint, GovTickInput,
  CivicPostKind, SpendKind, FirmDemandRow, GovTickResult, InstitutionState,
  BallotKind, BallotView, OfficeKind, OfficeHolder, OfficialView,
  CivicExchange, GovEventKind, GovEvent, GovHistoryView, GovTierAView, GovView,
} from './types';
