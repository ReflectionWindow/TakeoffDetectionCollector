package geom

import (
	"bytes"
	"fmt"
	"testing"
)

func catalogPDF(annots bool) []byte {
	var body bytes.Buffer
	body.WriteString("%PDF-1.1\n")
	off := map[int]int{}
	writeObj := func(id int, dict string) {
		off[id] = body.Len()
		fmt.Fprintf(&body, "%d 0 obj\n%s\nendobj\n", id, dict)
	}
	writeObj(1, "<< /Type /Catalog /Pages 2 0 R >>")
	writeObj(2, "<< /Type /Pages /Count 1 /Kids [3 0 R] >>")
	page := "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"
	if annots {
		page = "<< /Type /Page /Parent 2 0 R /Annots [4 0 R] /MediaBox [0 0 612 792] >>"
	}
	writeObj(3, page)
	if annots {
		writeObj(4, "<< /Type /Annot /Subtype /Square /Rect [0 0 10 10] >>")
	}
	size := 4
	if annots {
		size = 5
	}
	xrefAt := body.Len()
	fmt.Fprintf(&body, "xref\n0 %d\n0000000000 65535 f \n", size)
	for id := 1; id < size; id++ {
		fmt.Fprintf(&body, "%010d 00000 n \n", off[id])
	}
	fmt.Fprintf(&body, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", size, xrefAt)
	return body.Bytes()
}

func TestStripAnnotsKeepsXRef(t *testing.T) {
	pdf := catalogPDF(true)
	if !xrefStartValid(pdf) {
		t.Fatal("fixture xref should be valid")
	}
	out := StripAnnots(pdf)
	if bytes.Contains(out, []byte("/Annots")) {
		t.Fatal("annots still present")
	}
	if !xrefStartValid(out) {
		t.Fatal("strip invalidated startxref")
	}
	if len(out) < len(pdf) {
		t.Fatalf("strip shortened pdf %d -> %d", len(pdf), len(out))
	}
}

func TestEnsureXRefRepairsShortenedPDF(t *testing.T) {
	pdf := catalogPDF(true)
	broken := annotsArrayRe.ReplaceAll(pdf, nil)
	if xrefStartValid(broken) {
		t.Fatal("deleted annots should invalidate xref")
	}
	fixed := EnsureXRef(broken)
	if !xrefStartValid(fixed) {
		t.Fatal("repair left startxref invalid")
	}
	if !bytes.Contains(fixed, []byte("/Type /Catalog")) {
		t.Fatal("catalog missing after repair")
	}
}
