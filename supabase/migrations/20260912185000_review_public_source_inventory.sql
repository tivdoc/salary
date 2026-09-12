-- Exact compiled public-source document variants, including purchased-topic subsets.
-- Source recognition permits factual requests; it grants no legal activation.
-- Old night-law bytes remain present. No arbitrary public URL or self-hash is trusted.
create or replace function private.document_review_pinned_public_law(target_case uuid,candidate jsonb) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(candidate->>'case_id'=target_case::text and exists(select 1 from jsonb_array_elements($sources$[
  {
    "document_id": "il.annual-vacation.amendment15",
    "version_id": "IL_ANNUAL_VACATION_LAW_AMENDMENT_15_2016@review-20260912",
    "file_sha256": "ed2b522eec191c2a6d4b86967936762d4ce43598fd055c15fce98af6191ddeeb",
    "page_count": 2,
    "kind": "other",
    "label": "חוק חופשה שנתית והתיקונים שנבדקו",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "45c8cd3a5e5c5ad656ebff0e183f67440b2e13091240414bf690558a4b745b3b"
  },
  {
    "document_id": "il.annual-vacation.law",
    "version_id": "IL_ANNUAL_VACATION_LAW@review-20260912",
    "file_sha256": "280b2d6c2e4fba81b02263a78cf4fc6ff6c0b22e05218228bea643b32ae0d791",
    "page_count": 6,
    "kind": "other",
    "label": "חוק חופשה שנתית והתיקונים שנבדקו",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "45c8cd3a5e5c5ad656ebff0e183f67440b2e13091240414bf690558a4b745b3b"
  },
  {
    "document_id": "il.btl.average-wage.2026",
    "version_id": "IL_BTL_AVERAGE_WAGE_2026@20260912",
    "file_sha256": "457a0327af2240f9e92a9876018beb3bba259a1033dae882b6ce05b12ae5a1a2",
    "page_count": 1,
    "kind": "other",
    "label": "מקור לחישוב פנסיה — הוראות ופרמטרים לתקופה",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "d9ae0db778a393cc3edb0af45559efa43fa82cf65f6cf62f42f5bdf9a0f01d01"
  },
  {
    "document_id": "il.collective_agreements.original.1957",
    "version_id": "IL_COLLECTIVE_AGREEMENTS_ORIGINAL_1957@review-20260912",
    "file_sha256": "011a91048027ef096a2923a66fcb1747b4a70122d1cda63b06af767e6f5f2a61",
    "page_count": 4,
    "kind": "other",
    "label": "חוק הסכמים קיבוציים — מקור לרצפת הצו הכללי",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "2f5821ecee0ea77bb0798ce17df636e7dbd7a5629c3975b287886b5ab0ea8a65"
  },
  {
    "document_id": "il.contracts-general-amendment2.2011",
    "version_id": "IL_CONTRACTS_GENERAL_AMENDMENT2@official-2011-v1",
    "file_sha256": "4dd53104c2a023bed2fd12573b77c95017c941b58c77d75f0f1b3ba9a6a302ef",
    "page_count": 2,
    "kind": "other",
    "label": "חוק החוזים (חלק כללי), תיקון 2 — הפרסום הרשמי 26.1.2011",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "22d3b0f20f64121ab92e9e558ac8fb6579e393b7ae239c1d1dbe790f3c530f66"
  },
  {
    "document_id": "il.contracts-general-amendment3.2026",
    "version_id": "IL_CONTRACTS_GENERAL_AMENDMENT3@official-2026-v1",
    "file_sha256": "344446bf0a08b4e36df848f061a68811c671ee1a7fe1220539a447b96c91783d",
    "page_count": 2,
    "kind": "other",
    "label": "חוק החוזים (חלק כללי), תיקון 3 — הפרסום הרשמי 7.1.2026",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "22d3b0f20f64121ab92e9e558ac8fb6579e393b7ae239c1d1dbe790f3c530f66"
  },
  {
    "document_id": "il.contracts-general.official-compendium-2025",
    "version_id": "IL_CONTRACTS_GENERAL@official-compendium-2025-v1",
    "file_sha256": "090f0cb9a4f6388e54abc1dea61197436ec0082f85a19a5f8ff7dfcdae7d65f5",
    "page_count": 828,
    "kind": "other",
    "label": "חוק החוזים (חלק כללי) — קובץ ממשלתי מאוחד מיוני 2025",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "22d3b0f20f64121ab92e9e558ac8fb6579e393b7ae239c1d1dbe790f3c530f66"
  },
  {
    "document_id": "il.hours-work-rest-law.1951",
    "version_id": "IL_HOURS_WORK_REST_LAW@discovery-v0",
    "file_sha256": "ca770f73436663094f546e53bed93aeca867bbed7124991fecfa1a8d750fdcd9",
    "page_count": 6,
    "kind": "other",
    "label": "חוק שעות עבודה ומנוחה — מקור רשמי לחישוב המותנה",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "2d3be1afb43e053000bf7f1aec35cf36c448a71dc8bd239df2177b413e01fa62",
    "accepted_reading_sha256": [
      "2d3be1afb43e053000bf7f1aec35cf36c448a71dc8bd239df2177b413e01fa62",
      "d175a0917265f3eece5c0a3d74fdd8de201211b4433009650e77ff39503b7cc5"
    ]
  },
  {
    "document_id": "il.ilan-38313-03-18.2020",
    "version_id": "IL_ILAN_38313_03_18@third-party-copy-v1",
    "file_sha256": "5ef51ac55e012ccee582c2ffdcb0eb2489436bf747ec9cee59fdbf549f4a5b2d",
    "page_count": 51,
    "kind": "other",
    "label": "פסק דין איל״ן — עותק פסק הדין, סעיף 50",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "d175a0917265f3eece5c0a3d74fdd8de201211b4433009650e77ff39503b7cc5",
    "accepted_reading_sha256": [
      "d175a0917265f3eece5c0a3d74fdd8de201211b4433009650e77ff39503b7cc5"
    ]
  },
  {
    "document_id": "il.pension.general.2011",
    "version_id": "IL_GENERAL_PENSION_EXTENSION_ORDER_2011@review-20260912",
    "file_sha256": "2f1c4942e0130c55714801cc4a72aba40f77a2391ba72f6bd2d5b2d7094244d9",
    "page_count": 5,
    "kind": "other",
    "label": "מקור לחישוב פנסיה — הוראות ופרמטרים לתקופה",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "d9ae0db778a393cc3edb0af45559efa43fa82cf65f6cf62f42f5bdf9a0f01d01"
  },
  {
    "document_id": "il.pension.increase.2016",
    "version_id": "IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016@review-20260912",
    "file_sha256": "f3e7de9d9b36900e18efa33f0286a1eeddbb8e062d8a19e102af94967921dd70",
    "page_count": 3,
    "kind": "other",
    "label": "מקור לחישוב פנסיה — הוראות ופרמטרים לתקופה",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "d9ae0db778a393cc3edb0af45559efa43fa82cf65f6cf62f42f5bdf9a0f01d01"
  },
  {
    "document_id": "il.review.convalescence.2016",
    "version_id": "IL_CONVALESCENCE_ORDER_2016@yp7417-ai-review-20260912",
    "file_sha256": "948c9293772da0b38b6156d73602cb9b2abebd12f2c7465c68a2201c953a5768",
    "page_count": 16,
    "kind": "other",
    "label": "צו הבראה — מכסת ימים, ותק וחלקיות",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "cebe8e00dd5f1b111625ffc40311a05259b2e6bf5c0fdcec2a82bc887d4967ad",
    "accepted_reading_sha256": [
      "cebe8e00dd5f1b111625ffc40311a05259b2e6bf5c0fdcec2a82bc887d4967ad"
    ]
  },
  {
    "document_id": "il.review.convalescence.2026",
    "version_id": "IL_CONVALESCENCE_ORDER_2026@yp14863-ai-review-20260912",
    "file_sha256": "a6e530b57ffd0f66c27e8f7947d242e73b9baf44ab62e19dfbc9879a8a63dcde",
    "page_count": 8,
    "kind": "other",
    "label": "צו הבראה לשנת 2026 — פורסם באוגוסט 2026",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "cebe8e00dd5f1b111625ffc40311a05259b2e6bf5c0fdcec2a82bc887d4967ad",
    "accepted_reading_sha256": [
      "cebe8e00dd5f1b111625ffc40311a05259b2e6bf5c0fdcec2a82bc887d4967ad"
    ]
  },
  {
    "document_id": "il.review.convalescence.freeze2025",
    "version_id": "IL_CONVALESCENCE_FREEZE_2025@sh3384-ai-review-20260912",
    "file_sha256": "eba7e1fa570a3ece265d87f379543024da038ee51af3f959d4c74162f5edecfa",
    "page_count": 40,
    "kind": "other",
    "label": "חוק הקפאה והפחתה 2025 — גבול התחולה לשנת 2026",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "cebe8e00dd5f1b111625ffc40311a05259b2e6bf5c0fdcec2a82bc887d4967ad",
    "accepted_reading_sha256": [
      "cebe8e00dd5f1b111625ffc40311a05259b2e6bf5c0fdcec2a82bc887d4967ad"
    ]
  },
  {
    "document_id": "il.review.minimum-wage.source.0",
    "version_id": "IL_MIN_WAGE_LAW@20260909.4674f07928a2",
    "file_sha256": "4674f07928a2397b626db362c6c9b98b7c4e77e693e397463fdabd83c7f4f161",
    "page_count": 5,
    "kind": "other",
    "label": "מקור לשכר מינימום",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "f5f9443c5cad9f8891a2e36e9022b506dbb4f534c2e3a52d06aceb4e5c3afcd0",
    "accepted_reading_sha256": [
      "f5f9443c5cad9f8891a2e36e9022b506dbb4f534c2e3a52d06aceb4e5c3afcd0"
    ]
  },
  {
    "document_id": "il.review.minimum-wage.source.1",
    "version_id": "IL_WORKWEEK_ORDER_2018@20260909.d99d1f420b84",
    "file_sha256": "d99d1f420b8427f9734da2252791b0937478810a56ffd09939b39908cdd23787",
    "page_count": 8,
    "kind": "other",
    "label": "מקור לשכר מינימום",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "f5f9443c5cad9f8891a2e36e9022b506dbb4f534c2e3a52d06aceb4e5c3afcd0",
    "accepted_reading_sha256": [
      "f5f9443c5cad9f8891a2e36e9022b506dbb4f534c2e3a52d06aceb4e5c3afcd0"
    ]
  },
  {
    "document_id": "il.review.minimum-wage.source.2",
    "version_id": "IL_MIN_WAGE_NOTICE_2026@20260909.65af7940d69a",
    "file_sha256": "65af7940d69a7c1ea96ae9008d44132a140866010f281ac49fc5779f61bdb679",
    "page_count": 2,
    "kind": "other",
    "label": "מקור לשכר מינימום",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "f5f9443c5cad9f8891a2e36e9022b506dbb4f534c2e3a52d06aceb4e5c3afcd0",
    "accepted_reading_sha256": [
      "f5f9443c5cad9f8891a2e36e9022b506dbb4f534c2e3a52d06aceb4e5c3afcd0"
    ]
  },
  {
    "document_id": "il.review.minimum-wage.source.3",
    "version_id": "IL_MIN_WAGE_OFFICIAL_RATES@20260909.63bb67d11d02",
    "file_sha256": "63bb67d11d02ae1377d3979a5028303c9905900c998106263570046cecc5edb2",
    "page_count": 1,
    "kind": "other",
    "label": "מקור לשכר מינימום",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "f5f9443c5cad9f8891a2e36e9022b506dbb4f534c2e3a52d06aceb4e5c3afcd0",
    "accepted_reading_sha256": [
      "f5f9443c5cad9f8891a2e36e9022b506dbb4f534c2e3a52d06aceb4e5c3afcd0"
    ]
  },
  {
    "document_id": "il.sami-188-06.2010",
    "version_id": "IL_SAMI_188_06@third-party-copy-v1",
    "file_sha256": "8c4723675f4da6479ac0d69135083c3f80fafb523bc591b4ea8f3de668d0c28e",
    "page_count": 33,
    "kind": "other",
    "label": "פסק דין בוג׳ו — עותק פסק הדין, סעיף 35",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "d175a0917265f3eece5c0a3d74fdd8de201211b4433009650e77ff39503b7cc5",
    "accepted_reading_sha256": [
      "d175a0917265f3eece5c0a3d74fdd8de201211b4433009650e77ff39503b7cc5"
    ]
  },
  {
    "document_id": "il.short-work-week.2018",
    "version_id": "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018@discovery-v0.1",
    "file_sha256": "fa27b689656194ef65d207fd6f68ec7c54c2c78d4362b2a5a2a5d3a207831a4b",
    "page_count": 2,
    "kind": "other",
    "label": "צו הרחבה לקיצור שבוע העבודה — 2018",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "d175a0917265f3eece5c0a3d74fdd8de201211b4433009650e77ff39503b7cc5",
    "accepted_reading_sha256": [
      "d175a0917265f3eece5c0a3d74fdd8de201211b4433009650e77ff39503b7cc5"
    ]
  },
  {
    "document_id": "il.travel.general.2016",
    "version_id": "IL_GENERAL_TRAVEL_EXTENSION_ORDER_2016@review-20260912",
    "file_sha256": "a38a52224c50e92fef9dcf920b53d697aca42bd923639ded8cc592d5e0c43142",
    "page_count": 3,
    "kind": "other",
    "label": "צו החזר הוצאות נסיעה — מקור לחישוב",
    "period": null,
    "reading_origin": "ai_document_review",
    "reading_sha256": "6b1ea1721cf2930216fd9bf818d2b3517b87f5f0879f4ccc11dbbb556d924cff"
  }
]$sources$::jsonb) p
  where candidate=jsonb_build_object('case_id',target_case::text)||p),false);
$$;
revoke all on function private.document_review_pinned_public_law(uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
