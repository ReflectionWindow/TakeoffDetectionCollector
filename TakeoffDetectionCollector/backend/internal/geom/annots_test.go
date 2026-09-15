package geom

import (
	"bytes"
	"testing"
)

func TestStripAnnotsRemovesMarkup(t *testing.T) {
	pdf := []byte("%PDF-1.1\n3 0 obj<</Type/Page/Annots[4 0 R 5 0 R]/MediaBox[0 0 612 792]>>endobj\n%%EOF\n")
	out := StripAnnots(pdf)
	if bytes.Contains(out, []byte("/Annots")) {
		t.Fatalf("annots still present: %s", out)
	}
	if !bytes.Contains(out, []byte("/Type/Page")) {
		t.Fatal("page object removed")
	}
	if len(out) < len(pdf) {
		t.Fatalf("strip shortened pdf %d -> %d (breaks xref offsets)", len(pdf), len(out))
	}
}

func TestStripAnnotsLeavesPlainPDF(t *testing.T) {
	pdf := []byte("%PDF-1.1\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]>>endobj\n%%EOF\n")
	out := StripAnnots(pdf)
	if !bytes.Contains(out, []byte("/Type/Page")) {
		t.Fatal("page object removed")
	}
}
