// Command ingest links the 75 DPI COCO tree to clean vector PDFs.
//
// It uploads COCO jobs first, then attaches {slug}.pdf files. Bluebeam
// annotation markups are stripped on the server so the cleaner shows
// vector linework only.
//
//	go run ./cmd/ingest \
//	  --api http://localhost:8080 \
//	  --token dev \
//	  --coco /path/to/coco-redacted-good-jobs-louvers-metal-panels \
//	  --pdfs /path/to/vector-pdfs
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"time"
)

func main() {
	api := flag.String("api", env("COLLECTOR_API", "http://localhost:8080"), "collector API base URL")
	token := flag.String("token", env("COLLECTOR_TOKEN", "dev"), "bearer token")
	coco := flag.String("coco", "", "path to coco-redacted-good-jobs-louvers-metal-panels")
	pdfs := flag.String("pdfs", "", "path to vector PDFs named {slug}.pdf (no Bluebeam markups needed)")
	flag.Parse()
	if *coco == "" || *pdfs == "" {
		flag.Usage()
		os.Exit(2)
	}

	client := &http.Client{Timeout: 30 * time.Minute}

	log.Printf("importing COCO from %s", *coco)
	cocoBody, err := postDir(client, *api+"/v1/imports/coco", *token, *coco)
	if err != nil {
		log.Fatalf("coco import: %v", err)
	}
	var cocoRes struct {
		Imported int `json:"imported"`
	}
	_ = json.Unmarshal(cocoBody, &cocoRes)
	log.Printf("imported %d COCO jobs", cocoRes.Imported)

	log.Printf("attaching vector PDFs from %s", *pdfs)
	pdfBody, err := postDir(client, *api+"/v1/imports/pdfs", *token, *pdfs)
	if err != nil {
		log.Fatalf("pdf import: %v", err)
	}
	var pdfRes struct {
		Attached int `json:"attached"`
		Skipped  int `json:"skipped"`
	}
	_ = json.Unmarshal(pdfBody, &pdfRes)
	log.Printf("linked %d PDFs (%d skipped — no matching COCO slug)", pdfRes.Attached, pdfRes.Skipped)
	fmt.Println("done. Jobs are in Original. Claim one from the inbox to correct.")
}

func postDir(client *http.Client, url, token, dir string) ([]byte, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if err := mw.WriteField("dir", dir); err != nil {
		return nil, err
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, url, &buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("%s: %s", res.Status, body)
	}
	return body, nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
