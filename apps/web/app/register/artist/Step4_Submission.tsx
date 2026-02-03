"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getFirebaseAuth } from "../../../lib/firebaseClient";
import { clearDraft } from "../../../lib/artistDraft";

interface Step4Props {
  formData: any;
}

type SubmitStatus = "idle" | "submitting" | "success" | "error";

const DEFAULT_FUNCTIONS_BASE = (process.env.NEXT_PUBLIC_FUNCTIONS_BASE_URL || "https://asia-south1-kalaqaar-1cd70.cloudfunctions.net").replace(/\/$/, "");

export default function Step4_Submission({ formData }: Step4Props) {
  // Phase-1: KYC verification is handled after approval (ops-led). Do not block submissions.
  const PHASE1_KYC_BYPASS = true;

  const router = useRouter();
  const [status, setStatus] = useState<SubmitStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [redirectCountdown, setRedirectCountdown] = useState<number | null>(null);

  const summary = useMemo(() => {
    const completedPortfolioEntries = Array.isArray(formData.portfolioEntries)
      ? formData.portfolioEntries.filter((entry: any) => entry && entry.status === "done" && entry.url)
      : [];
    return {
      name: (formData.name || "").toString().trim(),
      email: (formData.email || "").toString().trim(),
      phone: (formData.phone || "").toString().trim(),
      city: (formData.cityKey || "").toString().trim(),
      category: (formData.categoryKey || "").toString().trim(),
      bioLength: typeof formData.bio === "string" ? formData.bio.trim().length : 0,
      portfolioCount: completedPortfolioEntries.length,
      languages: Array.isArray(formData.languages) ? formData.languages.filter((lang: any) => typeof lang === "string" && lang.trim()).length : 0,
      otpVerified: Boolean(formData.otpVerified),
      payoutIntent: formData.payoutSetupIntent || null,
      kycStatus: (formData.kycStatus || "").toString().trim(),
    };
  }, [formData]);

  const validateRequired = useCallback(() => {
    const required: Record<string, any> = {
      name: summary.name,
      email: summary.email,
      phone: summary.phone,
      category: summary.category,
      city: summary.city,
    };
    const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
    if (missing.length) {
      throw new Error(`Missing required fields: ${missing.join(", ")}. Please go back to Step 1 and complete the details.`);
    }
  }, [summary]);

  const ensureKycVerified = useCallback(async () => {
    if (PHASE1_KYC_BYPASS) return;
    const normalizedLocal = summary.kycStatus.toLowerCase();
    if (["verified", "completed"].includes(normalizedLocal)) return;

    const auth = getFirebaseAuth();
    const user = auth?.currentUser;
    if (!user) {
      throw new Error("Please verify your phone in Step 1 first, then complete KYC verification in Step 3.");
    }

    const idToken = await user.getIdToken();

    let apiBase = "/api";
    try {
      if (typeof window !== "undefined" && window.location && window.location.origin) {
        apiBase = `${window.location.origin}/api`;
      }
    } catch {
      // noop
    }

    const statusUrl = `${apiBase}/kyc/status`;
    let resp = await fetch(statusUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${idToken}` },
    });

    if (!resp.ok) {
      resp = await fetch(`${DEFAULT_FUNCTIONS_BASE}/getKycStatus`, {
        method: "GET",
        headers: { Authorization: `Bearer ${idToken}` },
      });
    }

    if (!resp.ok) {
      throw new Error("Unable to confirm KYC status. Please return to Step 3 and refresh your verification status.");
    }

    const data = await resp.json();
    const remoteStatus = (data?.status?.kycStatus || "").toString().toLowerCase();
    if (!["verified", "completed"].includes(remoteStatus)) {
      throw new Error("KYC verification is not complete. Please go back to Step 3 and finish verification before submitting.");
    }
  }, [PHASE1_KYC_BYPASS, summary.kycStatus]);

  const buildSubmissionPayload = useCallback(async () => {
    const auth = getFirebaseAuth();
    const user = auth?.currentUser;

    const rawPortfolioEntries = Array.isArray(formData.portfolioEntries)
      ? formData.portfolioEntries.filter((entry: any) => entry && entry.status !== "error")
      : [];
    const completedPortfolioEntries = rawPortfolioEntries.filter((entry: any) => entry.status === "done" && entry.url);
    const portfolioLinks = [
      formData.profilePhoto,
      ...completedPortfolioEntries.map((entry: any) => entry.url)
    ].filter(Boolean);

    const portfolioMeta = {
      total: completedPortfolioEntries.length,
      images: completedPortfolioEntries.filter((entry: any) => entry.type === "image").length,
      videos: completedPortfolioEntries.filter((entry: any) => entry.type === "video").length,
      hasProfilePhoto: Boolean(formData.profilePhoto),
      bioLength: typeof formData.bio === "string" ? formData.bio.trim().length : 0,
    };

    return {
      userId: user?.uid || null,
      displayName: summary.name,
      email: summary.email,
      phoneNumber: summary.phone,
      category: summary.category,
      city: summary.city,
      portfolioLinks,
      portfolioEntries: completedPortfolioEntries.map((entry: any) => ({
        url: entry.url,
        storagePath: entry.storagePath || null,
        type: entry.type || null,
        thumbnail: entry.thumbnail || null,
      })),
      portfolioMeta,
      bio: formData.bio || "",
      baseRate: formData.baseRate || null,
      experienceYears: formData.experienceYears || null,
      availability: formData.availability || null,
      otpVerified: Boolean(formData.otpVerified),
      profilePhoto: formData.profilePhoto || null,
      travelRadius: formData.travelRadius || null,
      travelRadiusKm: typeof formData.travelRadiusKm === "number" ? formData.travelRadiusKm : (typeof formData.travelRadius === "string" ? Number(formData.travelRadius) || null : null),
      languages: Array.isArray(formData.languages) ? formData.languages.filter((lang: any) => typeof lang === "string" && lang.trim()) : [],
      equipmentOwned: Array.isArray(formData.equipmentOwned) ? formData.equipmentOwned.filter((item: any) => typeof item === "string" && item.trim()) : [],
      isPhysicallyChallenged: Boolean(formData.isPhysicallyChallenged),
      accessibilityDetails: formData.accessibilityDetails || "",
      kycStatus: formData.kycStatus || null,
      upiId: formData.upiId || null,
      panNumber: formData.panNumber || null,
      aadhaarNumber: formData.aadhaarNumber || null,
      gstNumber: formData.gstNumber || null,
      bankAccount: formData.bankAccountNumber ? {
        accountName: formData.bankAccountName,
        accountNumber: formData.bankAccountNumber,
        ifsc: formData.bankIfsc,
        bankName: formData.bankName,
      } : null,
      inviteCode: (formData.inviteCode || "").toString().trim() || null,
    };
  }, [formData, summary]);

  const submitApplication = useCallback(async () => {
    if (status === "submitting") return;
    setStatus("submitting");
    setError(null);

    try {
      await ensureKycVerified();
      validateRequired();
      const submissionData = await buildSubmissionPayload();

      const submissionEndpoints: string[] = [];
      submissionEndpoints.push(`${DEFAULT_FUNCTIONS_BASE}/registerArtistApplication`);
      submissionEndpoints.push(`${DEFAULT_FUNCTIONS_BASE}/registerArtistLead`);

      let result: any = null;
      let lastError: string | null = null;
      let lastEndpoint: string | null = null;

      for (const endpoint of submissionEndpoints) {
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(submissionData),
          });

          let data: any = null;
          try {
            data = await response.json();
          } catch {
            data = null;
          }

          if (response.ok && data?.ok) {
            result = data;
            break;
          }

          const responseError = data?.error || `${response.status} ${response.statusText}`;
          lastError = responseError;
          lastEndpoint = endpoint;
        } catch (requestError: any) {
          lastError = requestError?.message || String(requestError);
          lastEndpoint = endpoint;
        }
      }

      if (!result) {
        const details = lastEndpoint ? ` (via ${lastEndpoint})` : "";
        throw new Error((lastError || "Failed to submit application") + details);
      }

      const code: string | null = result.referralCode || null;
      setReferralCode(code);
      setStatus("success");
    } catch (err: any) {
      console.error("Submission error:", err);
      setError(err?.message || "Failed to submit application. Please try again.");
      setStatus("error");
    }
  }, [buildSubmissionPayload, ensureKycVerified, status, validateRequired]);

  useEffect(() => {
    if (status !== "success") return;
    clearDraft();
    setRedirectCountdown(3);

    const interval = setInterval(() => {
      setRedirectCountdown((prev) => (prev && prev > 0 ? prev - 1 : null));
    }, 1000);

    const timeout = setTimeout(() => {
      if (referralCode) {
        router.push(`/register/thanks?code=${encodeURIComponent(referralCode)}`);
      } else {
        router.push("/register/thanks");
      }
    }, 3000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [referralCode, router, status]);

  if (status === "success") {
    return (
      <div style={{ textAlign: "center", padding: "3rem 0" }}>
        <div style={{ fontSize: "4rem", marginBottom: 24 }}>✅</div>
        <h2 style={{ margin: "0 0 12px", color: "#10b981" }}>Application Submitted Successfully!</h2>
        <p style={{ color: "var(--muted)", margin: "0 0 24px", maxWidth: 600, marginLeft: "auto", marginRight: "auto" }}>
          Thank you for registering with Kalaqaar! Your profile is now with our review team.
        </p>

        {referralCode && (
          <div style={{
            padding: 20,
            background: "rgba(16, 185, 129, 0.1)",
            border: "1px solid rgba(16, 185, 129, 0.3)",
            borderRadius: 12,
            maxWidth: 400,
            margin: "0 auto 24px"
          }}>
            <div style={{ fontSize: "0.875rem", color: "var(--muted)", marginBottom: 8 }}>
              Your Application Code
            </div>
            <div style={{ fontSize: "1.5rem", fontWeight: 700, color: "#10b981", fontFamily: "monospace" }}>
              {referralCode}
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: 8 }}>
              Save this code for future reference.
            </div>
          </div>
        )}

        <div style={{
          padding: 20,
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 12,
          maxWidth: 680,
          margin: "0 auto 24px",
          textAlign: "left",
          display: "grid",
          gap: 12,
        }}>
          <h3 style={{ margin: 0, fontSize: "1.1rem" }}>Next up on your checklist</h3>
          <ul style={{ margin: 0, paddingLeft: 20, color: "var(--muted)", lineHeight: 1.8 }}>
            <li>We’ll review and publish your profile within 24–48 hours.</li>
            <li>Want faster payouts later? Complete Cashfree from the dashboard when you’re ready to withdraw.</li>
            <li>Add more portfolio items or social proof any time from “Profile → Portfolio”.</li>
          </ul>
        </div>

        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className="primary"
            onClick={() => router.push(referralCode ? `/register/thanks?code=${encodeURIComponent(referralCode)}` : "/register/thanks")}
          >
            Go to confirmation page now
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => router.push("/dashboard")}
          >
            View dashboard checklist
          </button>
        </div>

        <p style={{ fontSize: "0.875rem", color: "var(--muted)", marginTop: 24 }}>
          Redirecting automatically{redirectCountdown !== null ? ` in ${redirectCountdown}s…` : " soon…"}
        </p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div style={{ textAlign: "center", padding: "3rem 0" }}>
        <div style={{ fontSize: "4rem", marginBottom: 24 }}>❌</div>
        <h2 style={{ margin: "0 0 12px", color: "#ff6b6b" }}>Submission Failed</h2>
        <p style={{ color: "var(--muted)", margin: "0 0 24px", maxWidth: 520, marginLeft: "auto", marginRight: "auto" }}>
          {error}
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <button type="button" className="primary" onClick={submitApplication}>
            Try submitting again
          </button>
          <Link href="/support" className="secondary" style={{ padding: "0.75rem 1.5rem", textDecoration: "none" }}>
            Contact Support
          </Link>
        </div>
      </div>
    );
  }

  const remainingTasks = [] as string[];
  if (!summary.otpVerified) remainingTasks.push("Verify your phone (done manually if OTP skipped)");
  if (!summary.portfolioCount || summary.portfolioCount < 3) remainingTasks.push("Upload at least 3 portfolio items");
  if (summary.bioLength < 100) remainingTasks.push("Bio must be at least 100 characters");
  if (!summary.languages) remainingTasks.push("Select the languages you perform in");

  return (
    <div style={{ display: "grid", gap: 24, paddingTop: 24 }}>
      <header style={{ textAlign: "center" }}>
        <h2 style={{ margin: "0 0 8px" }}>Final step: submit your artist profile</h2>
        <p style={{ margin: 0, color: "var(--muted)" }}>
          Review the essentials below, then hit submit. You can edit everything later from your dashboard.
        </p>
      </header>

      <section
        style={{
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(255,255,255,0.03)",
          padding: "1.25rem",
          display: "grid",
          gap: 12,
        }}
      >
        <strong style={{ fontSize: "1rem" }}>Summary</strong>
        <div style={{ display: "grid", gap: 8, fontSize: 14 }}>
          <span><strong>Name:</strong> {summary.name || "—"}</span>
          <span><strong>Email:</strong> {summary.email || "—"}</span>
          <span><strong>Phone:</strong> {summary.phone || "—"}</span>
          <span><strong>City / Category:</strong> {summary.city || "—"} · {summary.category || "—"}</span>
          <span><strong>Bio length:</strong> {summary.bioLength} characters</span>
          <span><strong>Portfolio items:</strong> {summary.portfolioCount}</span>
        </div>

        {remainingTasks.length > 0 && (
          <div
            style={{
              marginTop: 12,
              borderRadius: 10,
              border: "1px solid rgba(248,113,113,0.35)",
              background: "rgba(248,113,113,0.12)",
              padding: "0.75rem 1rem",
              color: "#fecaca",
              fontSize: 13,
            }}
          >
            <strong style={{ display: "block", marginBottom: 4 }}>Recommended fixes before submitting:</strong>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {remainingTasks.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {error && (
        <div
          style={{
            borderRadius: 8,
            border: "1px solid rgba(248,113,113,0.35)",
            background: "rgba(248,113,113,0.15)",
            padding: "0.75rem",
            color: "#fecaca",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          className="button-primary"
          onClick={submitApplication}
          disabled={status === "submitting"}
          aria-busy={status === "submitting" || undefined}
        >
          {status === "submitting" ? "Submitting…" : "Submit application"}
        </button>
        <Link href="/register/artist" className="button-secondary" style={{ padding: "0.75rem 1.5rem", textDecoration: "none" }}>
          Go back & edit details
        </Link>
      </div>

      {status === "submitting" && (
        <p style={{ textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
          Sending your application. Please keep this tab open for a moment…
        </p>
      )}
    </div>
  );
}
