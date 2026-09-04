package auth

import "testing"

func TestAllowedEmail(t *testing.T) {
	if !AllowedEmail("stephen@reflectionwindow.com", "reflectionwindow.com") {
		t.Fatal("company email should pass")
	}
	if AllowedEmail("someone@gmail.com", "reflectionwindow.com") {
		t.Fatal("other domain should fail")
	}
}
