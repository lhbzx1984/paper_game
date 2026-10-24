import re
from pathlib import Path

from reportlab.lib.enums import TA_JUSTIFY, TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
TEXT_PATH = ROOT / "data" / "demo_paper.txt"
OUT_PATH = ROOT / "data" / "sample_paper.pdf"


class NumberedCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        page_count = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self._draw_page_number(page_count)
            super().showPage()
        super().save()

    def _draw_page_number(self, page_count):
        self.setFont("Helvetica", 8)
        self.setFillColor(colors.HexColor("#777777"))
        self.drawCentredString(A4[0] / 2, 12 * mm, f"PaperQuest demo paper · {self._pageNumber} / {page_count}")


def build():
    raw = TEXT_PATH.read_text(encoding="utf-8").strip()
    lines = [line.rstrip() for line in raw.splitlines()]
    title = lines[0]
    authors = lines[1]
    affiliation = lines[2]

    body = lines[3:]
    blocks = []
    current = []
    for line in body:
        if not line.strip():
            if current:
                blocks.append(current)
                current = []
            continue
        current.append(line)
    if current:
        blocks.append(current)

    styles = {
        "title": ParagraphStyle(
            "title", fontName="Helvetica-Bold", fontSize=17, leading=22,
            alignment=TA_CENTER, textColor=colors.HexColor("#111827"), spaceAfter=8,
        ),
        "authors": ParagraphStyle(
            "authors", fontName="Helvetica", fontSize=10.5, leading=14,
            alignment=TA_CENTER, textColor=colors.HexColor("#374151"), spaceAfter=2,
        ),
        "affiliation": ParagraphStyle(
            "affiliation", fontName="Helvetica-Oblique", fontSize=9.5, leading=13,
            alignment=TA_CENTER, textColor=colors.HexColor("#6b7280"), spaceAfter=16,
        ),
        "section": ParagraphStyle(
            "section", fontName="Helvetica-Bold", fontSize=12, leading=15,
            textColor=colors.HexColor("#111827"), spaceBefore=12, spaceAfter=5,
        ),
        "subsection": ParagraphStyle(
            "subsection", fontName="Helvetica-Bold", fontSize=10.5, leading=14,
            textColor=colors.HexColor("#1f2937"), spaceBefore=8, spaceAfter=3,
        ),
        "body": ParagraphStyle(
            "body", fontName="Times-Roman", fontSize=10.5, leading=15.2,
            alignment=TA_JUSTIFY, textColor=colors.HexColor("#1f2937"), spaceAfter=8,
        ),
        "ref": ParagraphStyle(
            "ref", fontName="Times-Roman", fontSize=9.5, leading=13.5,
            textColor=colors.HexColor("#374151"), leftIndent=12, firstLineIndent=-12, spaceAfter=4,
        ),
    }

    story = [
        Paragraph(title, styles["title"]),
        Paragraph(authors, styles["authors"]),
        Paragraph(affiliation, styles["affiliation"]),
    ]

    section_re = re.compile(r"^(\d+(\.\d+)?\s+[A-Z][A-Za-z ]+|Abstract|References)$")
    for block in blocks:
        text = " ".join(block).strip()
        if not text:
            continue
        if section_re.match(text) and len(text) < 80:
            if text.startswith("References"):
                story.append(PageBreak())
                story.append(Paragraph(text, styles["section"]))
            elif re.match(r"^\d+\.\d+", text):
                story.append(Paragraph(text, styles["subsection"]))
            else:
                story.append(Paragraph(text, styles["section"]))
        else:
            style = styles["ref"] if text.startswith(("Chen,", "Devlin,", "Levine,", "Smith,", "Zhang,")) else styles["body"]
            story.append(Paragraph(text, style))

    doc = SimpleDocTemplate(
        str(OUT_PATH), pagesize=A4,
        leftMargin=24 * mm, rightMargin=24 * mm,
        topMargin=22 * mm, bottomMargin=22 * mm,
        title=title, author=authors,
    )
    doc.build(story, canvasmaker=NumberedCanvas)
    print(f"Wrote {OUT_PATH}")


if __name__ == "__main__":
    build()
