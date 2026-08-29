import { describe, expect, it } from "vitest";
import { classifyPermit8753 } from "./permit-8753.ts";

describe("premit-8753 classification", () => {
  it("classifies an exact catalog URL returning 404 as stale, without inventing a replacement", () => {
    expect(classifyPermit8753({
      stableId: "GOVIL-WORK-PERMIT:premit-8753",
      exactCatalogUrl: "https://www.gov.il/he/Departments/DynamicCollectors/work-permits?skip=10",
      exactOfficialArtifactUrl: "https://www.gov.il/BlobFolder/dynamiccollectorresultitem/premit-8753/he/workers-rights_working-conditions_permits-for-overtime-employment_8753.pdf",
      liveHttpStatus: 404,
      catalogUrlWasGenerated: false,
      explicitOfficialReplacementUrl: null,
      explicitOfficialReplacementEvidence: null,
    })).toMatchObject({ status: "stale_official_catalog_link", bypass_attempted: false, unofficial_substitution_used: false, replacement_claimed: false });
  });
});
