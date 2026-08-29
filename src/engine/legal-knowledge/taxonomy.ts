import { z } from "zod";

export const LEGAL_TAXONOMY_VERSION = "il-employment-legal-taxonomy-v0";

export const legalTopics = [
  "minimum_wage",
  "working_time",
  "overtime",
  "weekly_rest",
  "pension",
  "severance",
  "travel",
  "convalescence",
  "vacation",
  "sick_leave",
  "holidays",
  "salary_protection",
  "notice",
  "commissions",
] as const;

export const legalSectors = [
  "general",
  "security",
  "cleaning",
  "construction",
  "hospitality",
  "caregiving",
  "other",
  "unknown",
] as const;

export const legalTopicSchema = z.enum(legalTopics);
export const legalSectorSchema = z.enum(legalSectors);

export type LegalTopic = z.infer<typeof legalTopicSchema>;
export type LegalSector = z.infer<typeof legalSectorSchema>;
