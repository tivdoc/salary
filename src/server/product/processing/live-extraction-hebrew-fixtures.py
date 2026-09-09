"""Authored synthetic Hebrew source documents, never provider output or findings.

All source values below are literal independent test oracles. This script imports
no Tivdoc calculator, legal rule, provider adapter or generated financial report.
"""
import hashlib
import json
from pathlib import Path

import pdfplumber
import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFilter, ImageOps
from reportlab.lib.colors import HexColor, white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

ROOT = Path("docs/release-evidence/live-provider-june2026")
RENDER = Path("output/release-completion/live-provider-june2026")
FONT = Path("assets/fonts/DejaVuSans.ttf")
FONT_SHA = "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954"
assert hashlib.sha256(FONT.read_bytes()).hexdigest() == FONT_SHA
pdfmetrics.registerFont(TTFont("HebrewSource", str(FONT)))
ROOT.mkdir(parents=True, exist_ok=True)
RENDER.mkdir(parents=True, exist_ok=True)

# Minor-unit totals are specified independently, not computed by the engine.
COMMON = {
    "language": "he", "salaryType": "hourly", "employmentStartDate": "2025-01-15",
    "month": "2026-06", "baseMinor": 354000, "hourlyRateMinor": 3540,
    "grossMinor": 460870, "deductionsMinor": 41240, "netMinor": 419630,
    "overtime125Hours": "10", "overtime150Hours": "2", "travelMinor": 22000,
    "pensionBaseMinor": 354000, "pensionEmployeeMinor": 21240,
    "pensionEmployerMinor": 23010, "severanceMinor": 21240,
    "pensionEmployeeBasisPoints": 600, "pensionEmployerBasisPoints": 650,
    "severanceBasisPoints": 600,
    "deductions": [
        {"sourceLabel": "פנסיה עובד", "amountMinor": 21240, "page": 1},
        {"sourceLabel": "ביטוח לאומי", "amountMinor": 8000, "page": 1},
        {"sourceLabel": "ביטוח בריאות", "amountMinor": 12000, "page": 1},
        {"sourceLabel": "מס הכנסה", "amountMinor": 0, "page": 1},
    ],
    "expectedMinor": None, "gapMinor": None,
    "financialScenario": "outside_single_regular_base_engineering_scope",
    "equation": "354000 + 44250 + 10620 + 22000 + 30000 = 460870; 460870 - 41240 = 419630. No legal gap oracle: extra wage components are outside the current engineering calculator scenario.",
}
ORACLES = [
    {**COMMON, "id": "he-clear", "hours": ["100"], "outcome": "readable"},
    {**COMMON, "id": "he-missing-hours", "hours": [], "outcome": "essential_input_missing"},
    {**COMMON, "id": "he-conflicting-hours", "hours": ["100", "110"], "outcome": "conflicting_observations"},
]


def amount(minor):
    return f"{minor / 100:,.2f}"


def logical(c, text, draw):
    # Explicit ActualText keeps the logical Hebrew string alongside the visual
    # right-to-left glyph order. Numerical columns are separate LTR text runs.
    c._code.append(f"/Span << /ActualText <FEFF{text.encode('utf-16-be').hex().upper()}> >> BDC")
    draw()
    c._code.append("EMC")


def rtl(c, text, right, y, size=9, color="#172C38"):
    assert not any(ch.isdigit() for ch in text), "Keep digits in separate LTR cells"
    c.setFont("HebrewSource", size)
    c.setFillColor(HexColor(color))
    logical(c, text, lambda: c.drawRightString(right, y, text[::-1]))


def ltr(c, text, right, y, size=9):
    c.setFont("HebrewSource", size)
    c.setFillColor(HexColor("#172C38"))
    logical(c, text, lambda: c.drawRightString(right, y, text))


def rule(c, y, left=35, right=560):
    c.setStrokeColor(HexColor("#B7C4CD"))
    c.setLineWidth(0.45)
    c.line(left, y, right, y)


def section(c, text, left, right, y):
    c.setFillColor(HexColor("#E7EDF1"))
    c.rect(left, y-7, right-left, 25, stroke=0, fill=1)
    rtl(c, text, right-8, y+1, 10)


def make_pdf(oracle):
    file = ROOT / f"{oracle['id']}-june-2026.pdf"
    c = canvas.Canvas(str(file), pagesize=(595.28, 841.89), invariant=1, pageCompression=1)
    c.setTitle("Synthetic Hebrew Israeli payslip / " + oracle["id"])
    c.setSubject("Synthetic source only; no actual employee, employer, tax assessment or legal approval")
    c.setAuthor("Tivdoc synthetic verification corpus")
    c.setFillColor(HexColor("#173B4A"))
    c.rect(35, 755, 525, 55, stroke=0, fill=1)
    rtl(c, "תלוש שכר - נתונים סינתטיים בלבד", 548, 783, 17, "#FFFFFF")
    rtl(c, "מסמך מקור לבדיקת תוכנה - אין עובד או מעסיק אמיתיים", 548, 765, 9, "#FFFFFF")
    ltr(c, "SYNTHETIC / " + oracle["id"], 560, 737, 8)
    rtl(c, "מעבדה סינתטית בעמ", 548, 716, 11)
    rtl(c, "שם המעסיק", 548, 698, 8)
    rtl(c, "עובד בדיקה בגיר", 295, 716, 11)
    rtl(c, "שם העובד", 295, 698, 8)
    rule(c, 687)
    rtl(c, "תקופת שכר", 550, 671)
    ltr(c, "01/06/2026 - 30/06/2026", 430, 671)
    rtl(c, "תחילת עבודה", 255, 671)
    ltr(c, "15/01/2025", 125, 671)
    rtl(c, "סוג שכר", 550, 648)
    rtl(c, "שעתי", 430, 648)
    rtl(c, "מספר עובד", 255, 648)
    ltr(c, "TEST-JUN-001", 125, 648)
    rtl(c, "שעות רגילות בסיכום נוכחות", 550, 625, 8)
    if not oracle["hours"]:
        rtl(c, "לא תועד", 330, 625, 9)
    else:
        ltr(c, oracle["hours"][0], 330, 625)
    rtl(c, "מספר מזהה", 255, 625)
    rtl(c, "לא קיים - סינתטי", 125, 625, 8)

    section(c, "תשלומים ורכיבי שכר", 35, 560, 591)
    for text, right in [("קוד", 550), ("תיאור הרכיב", 500), ("כמות", 306), ("תעריף", 226), ("סכום בשקלים", 132)]:
        rtl(c, text, right, 570, 8)
    rule(c, 560)
    regular_qty = None if not oracle["hours"] else oracle["hours"][-1]
    rows = [
        ("001", "שכר יסוד שעתי", regular_qty, "35.40", 354000, "hourly_base"),
        ("125", "שעות נוספות", "10", "44.25", 44250, "overtime_125"),
        ("150", "שעות נוספות", "2", "53.10", 10620, "overtime_150"),
        ("300", "החזר נסיעות", "20", "11.00", 22000, "travel"),
        ("400", "בונוס חד פעמי", None, None, 30000, "bonus"),
    ]
    components = []
    for index, (code, label, qty, rate, minor, kind) in enumerate(rows):
        y = 541-index*27
        ltr(c, code, 550, y, 8)
        rtl(c, label, 500, y, 9)
        if kind.startswith("overtime_"):
            ltr(c, "125%" if kind.endswith("125") else "150%", 363, y, 8)
        ltr(c, qty if qty is not None else "-", 306, y)
        ltr(c, rate if rate is not None else "-", 226, y)
        ltr(c, amount(minor), 132, y)
        rule(c, y-10)
        components.append({"semanticKind": kind, "sourceLabel": label, "quantity": qty,
                           "rateMinor": {"hourly_base":3540,"overtime_125":4425,"overtime_150":5310,"travel":1100,"bonus":None}[kind],
                           "amountMinor":minor, "page":1})
    oracle["components"] = components
    rtl(c, "ברוטו לתשלום", 550, 393, 11)
    ltr(c, "4,608.70", 132, 393, 12)

    section(c, "ניכויי עובד", 35, 280, 356)
    section(c, "הפרשות פנסיוניות", 300, 560, 356)
    for index, (label, value) in enumerate([("פנסיה עובד", "212.40"), ("ביטוח לאומי", "80.00"), ("ביטוח בריאות", "120.00"), ("מס הכנסה", "0.00")]):
        y=333-index*22
        rtl(c, label, 271, y, 8.5)
        ltr(c, value, 100, y, 9)
    rtl(c, "בסיס להפרשות", 550, 333, 8.5)
    ltr(c, "3,540.00", 385, 333, 9)
    for index, (label, percent, value) in enumerate([("עובד", "6.00%", "212.40"), ("מעסיק", "6.50%", "230.10"), ("פיצויים", "6.00%", "212.40")]):
        y=311-index*22
        rtl(c, label, 550, y, 8.5)
        ltr(c, percent, 461, y, 8)
        ltr(c, value, 375, y, 9)
    rule(c, 237)
    rtl(c, "סך ניכויי עובד", 550, 216, 10)
    ltr(c, "412.40", 132, 216, 10)
    c.setFillColor(HexColor("#E7F0EA"))
    c.rect(35, 169, 525, 30, stroke=0, fill=1)
    rtl(c, "נטו לתשלום", 550, 180, 12)
    ltr(c, "4,196.30", 132, 180, 13)
    rtl(c, "כל הרכיבים והסכומים הומצאו לצורך בדיקת חילוץ מסמכים", 550, 137, 8)
    rtl(c, "הסכומים אינם קביעה של חבות מס, הפרשות נדרשות או זכאות משפטית", 550, 120, 8)
    if oracle["outcome"] == "essential_input_missing":
        rtl(c, "נתון חסר במקור: שעות העבודה הרגילות אינן מתועדות", 550, 101, 8)
    elif oracle["outcome"] == "conflicting_observations":
        rtl(c, "נתונים סותרים במקור: שעות נוכחות שונות משעות שכר היסוד", 550, 101, 8)
    ltr(c, "1 / 1", 560, 42, 8)
    c.save()
    return file


files=[]
images=[]
for oracle in ORACLES:
    file=make_pdf(oracle)
    content=file.read_bytes()
    with pdfplumber.open(file) as pdf:
        assert len(pdf.pages)==1
        text=pdf.pages[0].extract_text() or ""
        for value in ["01/06/2026", "30/06/2026", "15/01/2025", "4,608.70", "412.40", "4,196.30", "230.10"]:
            assert value in text, (oracle["id"], value)
    document=pdfium.PdfDocument(str(file));bitmap=document[0].render(scale=150/72)
    image=bitmap.to_pil().convert("RGB").copy();bitmap.close();document.close()
    image.save(RENDER / f"{oracle['id']}-render.png")
    images.append((oracle["id"],image))
    files.append({"id":oracle["id"],"path":file.as_posix(),"sha256":hashlib.sha256(content).hexdigest(),
                  "sizeBytes":len(content),"mimeType":"application/pdf","pageCount":1,"oracle":oracle})

scan=ImageOps.grayscale(images[0][1]).filter(ImageFilter.GaussianBlur(0.20))
scan_file=ROOT / "he-scan-clear-june-2026.png";scan.save(scan_file,optimize=False)
content=scan_file.read_bytes();scan_oracle={**ORACLES[0],"id":"he-scan-clear"}
files.append({"id":"he-scan-clear","path":scan_file.as_posix(),"sha256":hashlib.sha256(content).hexdigest(),
              "sizeBytes":len(content),"mimeType":"image/png","pageCount":1,"oracle":scan_oracle,
              "derivedFromSha256":files[0]["sha256"],"syntheticRasterSimulation":True,"actualScannerCapture":False})
images.append(("he-scan-clear",scan.convert("RGB")))
manifest={"schemaVersion":"tivdoc-live-extraction-corpus-v2","synthetic":True,"humanReview":False,
          "legalGoldenApproval":False,"providerCalled":False,"font":{"file":str(FONT),"sha256":FONT_SHA},"files":files}
(ROOT / "independent-input-oracles.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
sheet=Image.new("RGB",(1200,850),"#EAECEF");draw=ImageDraw.Draw(sheet)
for index,(name,image) in enumerate(images):
    image.thumbnail((285,780));x=index*300+8
    sheet.paste(image,(x,30));draw.text((x,10),name,fill="black")
sheet.save(RENDER / "hebrew-corpus-contact-sheet.png")
receipt={"state":"synthetic_hebrew_inputs_generated_and_text_checked","pdfCount":3,"rasterCount":1,
         "providerCalled":False,"liveOcrProved":False,"humanReview":False,"actualScannerCapture":False,
         "renderer":"pypdfium2","pdfAuthoring":"reportlab","textVerification":"pdfplumber","visualReview":"pending"}
(ROOT / "fixture-preparation.json").write_text(json.dumps(receipt,indent=2)+"\n",encoding="utf-8")
print(json.dumps(receipt))
