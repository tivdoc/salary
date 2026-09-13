import {z} from 'zod';

/** Receipt versions describe purchased coverage, independently of executor
 * capabilities. Never add today's topics while reading an older receipt. */
export const PURCHASE_TOPICS_VERSION='tivdoc-purchase-topics-v2' as const;
export const RELEASE_PURCHASE_TOPICS=['minimum_wage','working_time','pension','travel','convalescence','vacation','rest_day','bonuses','contract'] as const;
export const releasePurchaseTopicsSchema=z.array(z.enum(RELEASE_PURCHASE_TOPICS)).min(1).max(9).refine(topics=>new Set(topics).size===topics.length);
export type ReleasePurchaseTopic=typeof RELEASE_PURCHASE_TOPICS[number];
