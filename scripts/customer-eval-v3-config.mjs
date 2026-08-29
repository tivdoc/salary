export const CUSTOMER_EVAL_V3_PIPELINE = "customer-payslip-data-only-v3";

export const CUSTOMER_EVAL_V3_DOCUMENTS = [
  {
    id: "CUSTOMER_EVAL_001",
    v2Sha256: "c1a26f60eba112df4f3294a36d3a49f2c1ccb564c1fe48b19a67b22f25d25b2f",
    dimensions: { width: 537, height: 738 },
    allowlist: { left: 151, top: 203, width: 386, height: 497 },
    sections: [
      ["earnings_table", 203, 430],
      ["totals", 430, 485],
      ["pension_and_severance", 485, 590],
      ["travel_and_convalescence", 590, 700],
    ],
  },
  {
    id: "CUSTOMER_EVAL_002",
    v2Sha256: "a46d70b500aaf56d2de0a6ade980659aca62b88b3ff5efd187cd95b0044453b1",
    dimensions: { width: 546, height: 735 },
    allowlist: { left: 158, top: 205, width: 388, height: 485 },
    sections: [
      ["earnings_table", 205, 445],
      ["totals", 445, 540],
      ["pension_and_severance", 540, 690],
    ],
  },
  {
    id: "CUSTOMER_EVAL_003",
    v2Sha256: "8effb70da14562cfd5313781a3a2e17ad731783287852bfdb37767da69c0caac",
    dimensions: { width: 544, height: 728 },
    allowlist: { left: 147, top: 205, width: 397, height: 515 },
    sections: [
      ["earnings_table", 205, 350],
      ["totals", 350, 420],
      ["pension_and_severance", 420, 490],
      ["travel_and_convalescence", 490, 620],
      ["vacation_and_sick_balances", 620, 720],
    ],
  },
  {
    id: "CUSTOMER_EVAL_004",
    v2Sha256: "ad44c14c9bee0cf60687cd0cd81ce2d1fb8531601cf0cd1c9feec605a6f0c61b",
    dimensions: { width: 541, height: 736 },
    allowlist: { left: 164, top: 210, width: 377, height: 496 },
    sections: [
      ["earnings_table", 210, 500],
      ["totals", 500, 575],
      ["pension_and_severance", 575, 645],
      ["travel_and_convalescence", 645, 706],
    ],
  },
  {
    id: "CUSTOMER_EVAL_005",
    v2Sha256: "94b70ab675bc6e1b0dc1ee54a326759d87d3aa529c06a2d3ea2370efa0fe90ea",
    dimensions: { width: 526, height: 733 },
    allowlist: { left: 144, top: 205, width: 382, height: 470 },
    sections: [
      ["earnings_table", 205, 385],
      ["totals", 385, 460],
      ["pension_and_severance", 460, 540],
      ["travel_and_convalescence", 540, 675],
    ],
  },
];

export const CUSTOMER_EVAL_GROUND_TRUTH_FIELDS = [
  "salary_period",
  "base_salary",
  "gross_salary",
  "net_salary",
  "total_deductions",
  "pension_employee",
  "pension_employer",
  "severance_employer",
  "travel_amount",
  "vacation_balance",
  "sick_balance",
  "hourly_rate",
];
