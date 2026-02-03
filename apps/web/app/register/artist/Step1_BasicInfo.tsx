"use client";

import { useCallback, useEffect, useState, useMemo, useRef, type ChangeEvent, type FormEvent } from "react";
import { CATEGORIES_PHASE1_ARTISTS, type Category } from "../../../lib/categories";
import { SUPPORTED_CITIES, type City } from "../../../lib/cities";
import { startPhoneOtp, verifyPhoneOtp, getFirebaseAuth, type StartOtpResult } from "../../../lib/firebaseClient";
import { trackEvent } from "../../../lib/analytics";

interface Step1Props {
  formData: any;
  updateFormData: (data: any) => void;
  nextStep: () => void;
}

type OtpMode = "checking" | "available" | "unavailable";

const LANGUAGE_OPTIONS = [
  'English',
  'Hindi',
  'Marathi',
  'Gujarati',
  'Tamil',
  'Telugu',
  'Kannada',
  'Malayalam',
  'Bengali',
  'Punjabi',
];

const EQUIPMENT_OPTIONS = [
  'Camera (DSLR/Mirrorless)',
  'Drone',
  'Lighting kit',
  'Sound mixer',
  'Stage monitors',
  'Guitar amp',
  'DJ controller',
  'Laptop',
];

const EMAIL_REGEX = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const INDIAN_MOBILE_REGEX = /^\+91[6-9]\d{9}$/;

function normalizeIndianMobile(input: string): string | null {
  if (!input) return null;
  let raw = input.replace(/[^0-9+]/g, "").trim();
  if (!raw) return null;
  if (INDIAN_MOBILE_REGEX.test(raw)) return raw;
  if (raw.startsWith("+")) {
    raw = raw.slice(1);
    if (INDIAN_MOBILE_REGEX.test(`+${raw}`)) return `+${raw}`;
  }
  raw = raw.replace(/^0+/, "");
  if (/^91[6-9]\d{9}$/.test(raw)) return `+${raw}`;
  if (/^[6-9]\d{9}$/.test(raw)) return `+91${raw}`;
  return null;
}

function isValidEmail(value: string): boolean {
  return EMAIL_REGEX.test((value || "").trim());
}

export default function Step1_BasicInfo({ formData, updateFormData, nextStep }: Step1Props) {
  const [name, setName] = useState(formData.name || "");
  const [phone, setPhone] = useState(formData.phone || "+91 ");
  const [email, setEmail] = useState(formData.email || "");
  const [inviteCode, setInviteCode] = useState(formData.inviteCode || "");
  const [cityKey, setCityKey] = useState(formData.cityKey || "");
  const [categoryKey, setCategoryKey] = useState(formData.categoryKey || "");
  const [baseRate, setBaseRate] = useState(formData.baseRate || "");
  const [experienceYears, setExperienceYears] = useState(formData.experienceYears || "");
  const [availability, setAvailability] = useState(formData.availability || "");
  const [travelRadius, setTravelRadius] = useState<string>(() => {
    if (typeof formData.travelRadius === 'string') return formData.travelRadius;
    if (typeof formData.travelRadiusKm === 'number') return String(formData.travelRadiusKm);
    return "";
  });
  const [languages, setLanguages] = useState<string[]>(() => Array.isArray(formData.languages) ? formData.languages.filter((lang: any) => typeof lang === 'string' && lang.trim()) : []);
  const [equipmentOwned, setEquipmentOwned] = useState<string[]>(() => Array.isArray(formData.equipmentOwned) ? formData.equipmentOwned.filter((item: any) => typeof item === 'string' && item.trim()) : []);
  const [isPhysicallyChallenged, setIsPhysicallyChallenged] = useState<boolean>(Boolean(formData.isPhysicallyChallenged));
  const [accessibilityDetails, setAccessibilityDetails] = useState<string>(formData.accessibilityDetails || "");

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [otpSent, setOtpSent] = useState(false);
  const [otpVerified, setOtpVerified] = useState(Boolean(formData.otpVerified));
  const [otpCode, setOtpCode] = useState("");
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [otpMode, setOtpMode] = useState<OtpMode>("unavailable");
  const [mounted, setMounted] = useState(false);
  const otpAvailable = otpMode === "available";
  const [error, setError] = useState<string | null>(null);
  const [otpNotice, setOtpNotice] = useState<string | null>(null);
  const confirmationRef = useRef<StartOtpResult["confirmation"] | null>(null);
  // Ensure draft restore doesn't fight user chip clicks
  const restoredRef = useRef<boolean>(false);

  const arraysEqual = useCallback((a: string[] | undefined, b: string[] | undefined) => {
    if (!Array.isArray(a) && !Array.isArray(b)) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }, []);

  const categories = useMemo(
    () => CATEGORIES_PHASE1_ARTISTS.map((c: Category) => ({ key: c.key, title: c.title })),
    []
  );
  const cityOptions = useMemo(
    () => [{ key: 'mumbai', title: 'Mumbai' }],
    []
  );

  const syncField = useCallback((fields: Record<string, unknown>) => {
    updateFormData(fields);
  }, [updateFormData]);

  // Keep local state aligned with restored draft values
  useEffect(() => {
    const nextName = formData?.name || "";
    setName((prev: string) => (prev === nextName ? prev : nextName));

    const nextPhone = formData?.phone || "+91 ";
    setPhone((prev: string) => (prev === nextPhone ? prev : nextPhone));

    const nextEmail = formData?.email || "";
    setEmail((prev: string) => (prev === nextEmail ? prev : nextEmail));

    const nextCity = formData?.cityKey || "";
    setCityKey((prev: string) => (prev === nextCity ? prev : nextCity));

    const nextCategory = formData?.categoryKey || "";
    setCategoryKey((prev: string) => (prev === nextCategory ? prev : nextCategory));

    const nextBaseRate = formData?.baseRate || "";
    setBaseRate((prev: string) => (prev === nextBaseRate ? prev : nextBaseRate));

    const nextExperience = formData?.experienceYears || "";
    setExperienceYears((prev: string) => (prev === nextExperience ? prev : nextExperience));

    const nextAvailability = formData?.availability || "";
    setAvailability((prev: string) => (prev === nextAvailability ? prev : nextAvailability));

    const nextTravel = (() => {
      if (typeof formData?.travelRadius === 'string') return formData.travelRadius;
      if (typeof formData?.travelRadiusKm === 'number') return String(formData.travelRadiusKm);
      return "";
    })();
    setTravelRadius((prev: string) => (prev === nextTravel ? prev : nextTravel));

    if (!restoredRef.current) {
      const nextLanguages = Array.isArray(formData?.languages)
        ? formData.languages.filter((lang: any) => typeof lang === 'string' && lang.trim())
        : [];
      setLanguages((prev: string[]) => (arraysEqual(prev, nextLanguages) ? prev : nextLanguages));
    }

    if (!restoredRef.current) {
      const nextEquipment = Array.isArray(formData?.equipmentOwned)
        ? formData.equipmentOwned.filter((item: any) => typeof item === 'string' && item.trim())
        : [];
      setEquipmentOwned((prev: string[]) => (arraysEqual(prev, nextEquipment) ? prev : nextEquipment));
    }

    const nextChallenge = Boolean(formData?.isPhysicallyChallenged);
    setIsPhysicallyChallenged((prev: boolean) => (prev === nextChallenge ? prev : nextChallenge));

    const nextAccessibility = formData?.accessibilityDetails || "";
    setAccessibilityDetails((prev: string) => (prev === nextAccessibility ? prev : nextAccessibility));

    const nextOtpVerified = Boolean(formData?.otpVerified);
    setOtpVerified((prev: boolean) => (prev === nextOtpVerified ? prev : nextOtpVerified));
    if (!restoredRef.current) restoredRef.current = true;
  }, [formData, arraysEqual]);

  useEffect(() => {
    if (otpMode === "unavailable") {
      setOtpNotice("Our team will verify your phone manually. You can continue onboarding and unlock payouts later.");
      syncField({ otpVerificationStatus: "deferred", otpVerified: false });
    } else if (otpMode === "available") {
      setOtpNotice(null);
    }
  }, [otpMode, syncField]);

  useEffect(() => {
    syncField({ equipmentOwned });
  }, [equipmentOwned, syncField]);

  const handleNameChange = useCallback((value: string) => {
    setName(value);
    setFieldErrors((prev) => ({ ...prev, name: '' }));
    syncField({ name: value });
  }, [syncField]);

  const handleEmailChange = useCallback((value: string) => {
    setEmail(value);
    setFieldErrors((prev) => ({ ...prev, email: '' }));
    syncField({ email: value });
  }, [syncField]);

  const handleInviteCodeChange = useCallback((value: string) => {
    setInviteCode(value);
    syncField({ inviteCode: value });
  }, [syncField]);

  const handlePhoneChange = useCallback((value: string) => {
    setPhone(value);
    setFieldErrors((prev) => ({ ...prev, phone: '' }));
    syncField({ phone: value });
  }, [syncField]);

  const handleCityChange = useCallback((value: string) => {
    setCityKey(value);
    setFieldErrors((prev) => ({ ...prev, city: '' }));
    syncField({ cityKey: value });
  }, [syncField]);

  const handleCategoryChange = useCallback((value: string) => {
    setCategoryKey(value);
    setFieldErrors((prev) => ({ ...prev, category: '' }));
    syncField({ categoryKey: value });
  }, [syncField]);

  const handleBaseRateChange = useCallback((value: string) => {
    setBaseRate(value);
    setFieldErrors((prev) => ({ ...prev, baseRate: '' }));
    syncField({ baseRate: value });
  }, [syncField]);

  const handleExperienceChange = useCallback((value: string) => {
    setExperienceYears(value);
    setFieldErrors((prev) => ({ ...prev, experienceYears: '' }));
    syncField({ experienceYears: value });
  }, [syncField]);

  const handleAvailabilityChange = useCallback((value: string) => {
    setAvailability(value);
    setFieldErrors((prev) => ({ ...prev, availability: '' }));
    syncField({ availability: value });
  }, [syncField]);

  const handleTravelRadiusChange = useCallback((value: string) => {
    setTravelRadius(value);
    const numeric = Number(value);
    syncField({
      travelRadius: value,
      travelRadiusKm: Number.isFinite(numeric) && numeric > 0 ? numeric : null,
    });
    setFieldErrors((prev) => ({ ...prev, travelRadius: '' }));
  }, [syncField]);

  const handleLanguageToggle = useCallback((language: string) => {
    let nextSelection: string[] = [];
    setLanguages((prev) => {
      const exists = prev.includes(language);
      const next = exists ? prev.filter((item) => item !== language) : [...prev, language];
      nextSelection = next;
      return next;
    });
    setFieldErrors((prev) => {
      if (!prev.languages || nextSelection.length === 0) return prev;
      const { languages: _lang, ...rest } = prev;
      return rest;
    });
    syncField({ languages: nextSelection });
  }, [syncField]);

  const handleEquipmentToggle = useCallback((item: string) => {
    setEquipmentOwned((prev) => {
      if (prev.includes(item)) {
        return prev.filter((equipment) => equipment !== item);
      }
      return [...prev, item];
    });
  }, []);

  const handleAccessibilityToggle = useCallback((checked: boolean) => {
    setIsPhysicallyChallenged(checked);
    if (!checked) {
      setAccessibilityDetails('');
      syncField({ accessibilityDetails: '', isPhysicallyChallenged: false });
    } else {
      syncField({ isPhysicallyChallenged: true, accessibilityDetails });
    }
  }, [accessibilityDetails, syncField]);

  const handleAccessibilityDetailsChange = useCallback((value: string) => {
    setAccessibilityDetails(value);
    syncField({ accessibilityDetails: value });
  }, [syncField]);

  const persistOtpStatus = useCallback((verified: boolean) => {
    setOtpVerified(verified);
    syncField({
      otpVerified: verified,
      otpVerificationStatus: verified ? "verified" : "pending",
    });
  }, [syncField]);

  async function handleSendOtp() {
    setError(null);
    const normalizedPhone = normalizeIndianMobile(phone);
    if (!normalizedPhone) {
      setFieldErrors({ phone: "Enter a valid Indian mobile number (+91 followed by 10 digits starting 6-9)." });
      return;
    }
    setSendingOtp(true);
    try {
      const { confirmation } = await startPhoneOtp("recaptcha-container", normalizedPhone);
      confirmationRef.current = confirmation;
      setOtpSent(true);
      trackEvent('otp_sent', { channel: 'firebase' });
      setPhone(normalizedPhone);
      syncField({ phone: normalizedPhone, otpSent: true });
    } catch (err: any) {
      setFieldErrors({ phone: err?.message || "Failed to send OTP. Try again later." });
    } finally {
      setSendingOtp(false);
    }
  }

  async function handleVerifyOtp() {
    setError(null);
    if (!confirmationRef.current) {
      setFieldErrors({ otp: "OTP not requested yet." });
      return;
    }
    if (!otpCode || otpCode.trim().length < 4) {
      setFieldErrors({ otp: "Enter the 6-digit OTP." });
      return;
    }
    setVerifyingOtp(true);
    try {
      await verifyPhoneOtp(confirmationRef.current, otpCode.trim());
      persistOtpStatus(true);
      setFieldErrors((prev: Record<string, string>) => {
        if (!prev.otp) return prev;
        const { otp, ...rest } = prev;
        return rest;
      });
    } catch (err: any) {
      setFieldErrors({ otp: err?.message || "Invalid OTP. Please try again." });
      persistOtpStatus(false);
    } finally {
      setVerifyingOtp(false);
    }
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const errors: Record<string, string> = {};

    if (!name || name.trim().length < 2) {
      errors.name = "Please enter your full name (at least 2 characters).";
    }
    const normalizedPhone = normalizeIndianMobile(phone);
    const trimmedEmail = email.trim();

    if (!normalizedPhone) {
      errors.phone = "Please enter a valid Indian mobile number (+91 XXXXX XXXXX).";
    }
    if (!trimmedEmail || !isValidEmail(trimmedEmail)) {
      errors.email = "Please enter a valid email address.";
    }
    if (!cityKey) {
      errors.city = "Please select your city from the list.";
    }
    if (!categoryKey) {
      errors.category = "Please select your primary category.";
    }
    if (!baseRate) {
        errors.baseRate = "Please enter your base rate.";
    }
    if (!experienceYears) {
        errors.experienceYears = "Please enter your years of experience.";
    }

    if (otpAvailable && !otpVerified) {
      errors.otp = "Verify your phone number to continue.";
    }

    if (!travelRadius || Number.isNaN(Number(travelRadius)) || Number(travelRadius) <= 0) {
      errors.travelRadius = "Enter how far you typically travel for gigs (in km).";
    }

    if (!languages.length) {
      errors.languages = "Select at least one language you can perform or communicate in.";
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    syncField({
      name,
      phone: normalizedPhone!,
      email: trimmedEmail,
      cityKey,
      categoryKey,
      baseRate,
      experienceYears,
      availability,
      otpVerified: otpVerified,
      otpVerificationStatus: otpAvailable ? (otpVerified ? "verified" : "pending") : "deferred",
      travelRadius,
      travelRadiusKm: Number(travelRadius),
      languages,
      equipmentOwned,
      isPhysicallyChallenged,
      accessibilityDetails,
    });
    nextStep();
  };

  useEffect(() => {
    setMounted(true);
    try {
      const auth = getFirebaseAuth();
      if (auth?.app) {
        setOtpMode("available");
        return;
      }
    } catch (_err) {
      // fall through to unavailable
    }
    setOtpMode("unavailable");
  }, []);

  // Sync otpVerified with actual Firebase Auth state (only on client)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (otpMode !== "available") return;
    const auth = getFirebaseAuth();
    if (!auth) return;
    
    // Check if user is actually signed in
    const checkAuthState = () => {
      if (auth.currentUser) {
        // User is signed in, ensure otpVerified is true
        if (!otpVerified) {
          persistOtpStatus(true);
        }
      } else {
        // User not signed in, clear otpVerified from draft
        if (otpVerified) {
          persistOtpStatus(false);
          setOtpSent(false);
        }
      }
    };
    
    // Check immediately
    checkAuthState();
    
    // Also listen for auth state changes
    const unsubscribe = auth.onAuthStateChanged(checkAuthState);
    return () => unsubscribe();
  }, [otpMode, otpVerified, persistOtpStatus]);

  if (!mounted) {
    return (
      <div style={{ padding: '2rem 0', textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
        Loading your saved details…
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12, marginTop: 16 }}>
        <div>
          <label htmlFor="name" style={{ display: "block", marginBottom: 6 }}>Full name *</label>
          <input
            type="text"
            required
            id="name"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="Enter your name"
            autoComplete="name"
            aria-invalid={!!fieldErrors.name}
            style={{
              width: "100%",
              padding: "0.75rem",
              borderRadius: 8,
              border: fieldErrors.name ? "1px solid #ff6b6b" : "1px solid rgba(255,255,255,0.12)",
              background: "transparent",
              color: "inherit",
            }}
          />
          {fieldErrors.name && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.name}</p>}
        </div>

        <div>
          <label htmlFor="email" style={{ display: "block", marginBottom: 6 }}>Email *</label>
          <input
            type="email"
            id="email"
            required
            value={email}
            onChange={(e) => handleEmailChange(e.target.value)}
            placeholder="you@example.com (required)"
            autoComplete="email"
            aria-invalid={!!fieldErrors.email}
            style={{
              width: "100%",
              padding: "0.75rem",
              borderRadius: 8,
              border: fieldErrors.email ? "1px solid #ff6b6b" : "1px solid rgba(255,255,255,0.12)",
              background: "transparent",
              color: "inherit",
            }}
          />
          {fieldErrors.email && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.email}</p>}
        </div>

        <div>
          <label htmlFor="phone">Phone Number *</label>
          <input
            id="phone"
            type="tel"
            value={phone}
            onChange={(e) => handlePhoneChange(e.target.value)}
            placeholder="Your WhatsApp/phone number"
            autoComplete="tel"
            aria-invalid={!!fieldErrors.phone}
            style={{
              width: "100%",
              padding: "0.75rem",
              borderRadius: 8,
              border: fieldErrors.phone ? "1px solid #ff6b6b" : "1px solid rgba(255,255,255,0.12)",
              background: "transparent",
              color: "inherit",
            }}
            onFocus={() => trackEvent('register_start')}
          />
          {fieldErrors.phone && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.phone}</p>}
          <div id="recaptcha-container" suppressHydrationWarning />
          {mounted && otpNotice && (
            <div
              style={{
                marginTop: 8,
                borderRadius: 8,
                border: '1px solid rgba(148,163,184,0.35)',
                background: 'rgba(148,163,184,0.15)',
                padding: '0.75rem',
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              {otpNotice}
            </div>
          )}
          {mounted && otpAvailable ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {!otpSent && (
                <button type="button" className="button-secondary" onClick={handleSendOtp} disabled={sendingOtp} aria-busy={sendingOtp || undefined}>
                  {sendingOtp ? 'Sending…' : 'Send OTP'}
                </button>
              )}
              {otpSent && !otpVerified && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="Enter OTP"
                    value={otpCode}
                    onChange={(e) => {
                      setOtpCode(e.target.value);
                      syncField({ otpCode: e.target.value });
                    }}
                    style={{
                      padding: '0.5rem 0.75rem',
                      borderRadius: 8,
                      border: '1px solid rgba(255,255,255,0.12)',
                      background: 'transparent',
                      color: 'inherit',
                    }}
                  />
                  <button type="button" className="button-secondary" onClick={handleVerifyOtp} disabled={verifyingOtp} aria-busy={verifyingOtp || undefined}>
                    {verifyingOtp ? 'Verifying…' : 'Verify OTP'}
                  </button>
                </div>
              )}
              {otpVerified && (
                <span style={{ color: '#9ff2b0', fontSize: 12 }}>Phone verified ✓</span>
              )}
            </div>
          ) : (mounted && !otpNotice ? (
            <div
              style={{
                marginTop: 8,
                borderRadius: 8,
                border: '1px solid rgba(148,163,184,0.35)',
                background: 'rgba(148,163,184,0.15)',
                padding: '0.75rem',
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              Phone verification will be confirmed manually by our team before payouts. You can keep onboarding now.
            </div>
          ) : null)}
          {fieldErrors.otp && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.otp}</p>}
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
          <div>
          <label htmlFor="city" style={{ display: "block", marginBottom: 6 }}>City (Tier‑1) *</label>
          <select
            id="city"
            value={cityKey}
            onChange={(e) => handleCityChange(e.target.value)}
            required
            aria-invalid={!!fieldErrors.city}
            style={{
              width: "100%",
              padding: "0.75rem",
              borderRadius: 8,
                border: fieldErrors.city ? "1px solid #ff6b6b" : "1px solid rgba(255,255,255,0.12)",
                background: "transparent",
                color: "inherit",
              }}
          >
            <option value="">Select city</option>
            {cityOptions.map((c) => (
              <option key={c.key} value={c.key}>{c.title}</option>
            ))}
          </select>
          {fieldErrors.city && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.city}</p>}
        </div>
        <div>
          <label htmlFor="category" style={{ display: "block", marginBottom: 6 }}>Primary category *</label>
          <select
            id="category"
            value={categoryKey}
            onChange={(e) => handleCategoryChange(e.target.value)}
            required
            aria-invalid={!!fieldErrors.category}
            style={{
              width: "100%",
              padding: "0.75rem",
              borderRadius: 8,
                border: fieldErrors.category ? "1px solid #ff6b6b" : "1px solid rgba(255,255,255,0.12)",
                background: "transparent",
                color: "inherit",
            }}
          >
            <option value="">Select category</option>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>{c.title}</option>
            ))}
          </select>
          {fieldErrors.category && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.category}</p>}
	        </div>
	      </div>

        <div style={{ marginTop: 12 }}>
          <label htmlFor="invite-code" style={{ display: "block", marginBottom: 6 }}>
            Invite / Referral code (optional)
          </label>
          <input
            id="invite-code"
            type="text"
            value={inviteCode}
            onChange={(e) => handleInviteCodeChange(e.target.value)}
            placeholder="Enter referral code (if you have one)"
            style={{
              width: "100%",
              padding: "0.75rem",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "transparent",
              color: "inherit",
            }}
          />
            <p style={{ opacity: 0.75, fontSize: 12, marginTop: 6 }}>
              If you have a referral code, enter it for faster review. Organic signups are also welcome.
            </p>
        </div>

	        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
	          <div>
	            <label htmlFor="base-rate" style={{ display: "block", marginBottom: 6 }}>Starting gig rate (₹)</label>
	            <input
              type="text"
              id="base-rate"
              value={baseRate}
              onChange={(e) => handleBaseRateChange(e.target.value)}
              placeholder="e.g., 15000"
              style={{
                width: "100%",
                padding: "0.75rem",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "transparent",
                color: "inherit",
              }}
            />
            <p style={{ opacity: 0.75, fontSize: 12, marginTop: 6 }}>
              Clients see this as your baseline rate. You can negotiate inside the app later.
            </p>
            {fieldErrors.baseRate && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.baseRate}</p>}
          </div>
          <div>
            <label htmlFor="experience-years" style={{ display: "block", marginBottom: 6 }}>Experience (years)</label>
            <input
              type="number"
              min={0}
              id="experience-years"
              value={experienceYears}
              onChange={(e) => handleExperienceChange(e.target.value)}
              placeholder="e.g., 5"
              style={{
                width: "100%",
                padding: "0.75rem",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "transparent",
                color: "inherit",
              }}
            />
            {fieldErrors.experienceYears && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.experienceYears}</p>}
          </div>
          <div>
            <label htmlFor="availability" style={{ display: "block", marginBottom: 6 }}>Availability (next 30 days) *</label>
            <select
              id="availability"
              value={availability}
              onChange={(e) => handleAvailabilityChange(e.target.value)}
              required
              style={{
                width: "100%",
                padding: "0.75rem",
                borderRadius: 8,
                border: fieldErrors.availability ? "1px solid #ff6b6b" : "1px solid rgba(255,255,255,0.12)",
                background: "transparent",
                color: "inherit",
              }}
            >
              <option value="">Select availability</option>
              <option value="Weekends only">Weekends only</option>
              <option value="Weekdays only">Weekdays only</option>
              <option value="Full-time available">Full-time available</option>
              <option value="Part-time available">Part-time available</option>
              <option value="By appointment">By appointment</option>
            </select>
            <p style={{ opacity: 0.75, fontSize: 12, marginTop: 6 }}>
              This helps Ops schedule you. If you have blackout dates in the next 30 days, mention them in your bio or share with Ops after approval.
            </p>
            {fieldErrors.availability && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.availability}</p>}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginTop: 12 }}>
          <div>
            <label htmlFor="travel-radius" style={{ display: 'block', marginBottom: 6 }}>Travel radius (km) *</label>
            <input
              id="travel-radius"
              type="number"
              min={0}
              value={travelRadius}
              onChange={(e) => handleTravelRadiusChange(e.target.value)}
              placeholder="e.g., 50"
              style={{
                width: '100%',
                padding: '0.75rem',
                borderRadius: 8,
                border: fieldErrors.travelRadius ? '1px solid #ff6b6b' : '1px solid rgba(255,255,255,0.12)',
                background: 'transparent',
                color: 'inherit',
              }}
            />
            {fieldErrors.travelRadius && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.travelRadius}</p>}
            <p style={{ opacity: 0.75, fontSize: 12, marginTop: 6 }}>Approximate distance you’re willing to travel for paid work.</p>
          </div>
          <div>
            <label htmlFor="accessibility" style={{ display: 'block', marginBottom: 6 }}>Accessibility</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                id="accessibility"
                type="checkbox"
                checked={isPhysicallyChallenged}
                onChange={(e) => handleAccessibilityToggle(e.target.checked)}
                aria-describedby="accessibility-help"
              />
              <label htmlFor="accessibility" style={{ margin: 0, cursor: 'pointer' }}>
                I am physically challenged and would like additional support
              </label>
            </div>
            <p id="accessibility-help" style={{ opacity: 0.75, fontSize: 12, marginTop: 6 }}>
              Tell us if you need on-site assistance so we can plan accordingly.
            </p>
            {isPhysicallyChallenged && (
              <>
                <label htmlFor="accessibility-notes" style={{ display: 'block', marginBottom: 6, marginTop: 6 }}>Accessibility notes (optional)</label>
                <textarea
                  id="accessibility-notes"
                  value={accessibilityDetails}
                  onChange={(e) => handleAccessibilityDetailsChange(e.target.value)}
                  placeholder="Share anything we should know to support you better"
                  rows={3}
                  aria-describedby="accessibility-help"
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'transparent',
                    color: 'inherit',
                  }}
                />
              </>
            )}
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 8 }}>Languages you work in *</h3>
          <p style={{ opacity: 0.75, fontSize: 12, marginBottom: 8 }}>Select all languages you’re comfortable performing and communicating in.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {LANGUAGE_OPTIONS.map((language) => {
              const selected = languages.includes(language);
              return (
                <button
                  key={language}
                  type="button"
                  onClick={() => handleLanguageToggle(language)}
                  style={{
                    padding: '0.45rem 0.9rem',
                    borderRadius: 999,
                    border: selected ? '1px solid rgba(96,165,250,0.8)' : '1px solid rgba(255,255,255,0.18)',
                    background: selected ? 'rgba(96,165,250,0.15)' : 'rgba(255,255,255,0.06)',
                    color: 'inherit',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  {language}
                </button>
              );
            })}
          </div>
          {fieldErrors.languages && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.languages}</p>}
        </div>

        {/* Show equipment only for categories that typically need gear */}
        {(categoryKey === 'photographer' || categoryKey === 'videographer' || categoryKey === 'dj' || categoryKey === 'musician' || categoryKey === 'band') && (
          <div style={{ marginTop: 16 }}>
            <h3 style={{ marginBottom: 8 }}>Equipment you typically bring</h3>
            <p style={{ opacity: 0.75, fontSize: 12, marginBottom: 8 }}>Clients use this to understand if you're self-sufficient or need additional gear on-site.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {EQUIPMENT_OPTIONS.map((item) => {
                const selected = equipmentOwned.includes(item);
                return (
                  <button
                    key={item}
                    type="button"
                    onClick={() => handleEquipmentToggle(item)}
                    style={{
                      padding: '0.45rem 0.9rem',
                      borderRadius: 999,
                      border: selected ? '1px solid rgba(134,239,172,0.8)' : '1px solid rgba(255,255,255,0.18)',
                      background: selected ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.06)',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: 12,
                      textAlign: 'left',
                      lineHeight: 1.2,
                    }}
                  >
                    {item}
                  </button>
                );
              })}
            </div>
          </div>
        )}

      {error && (
        <p style={{ color: '#ff6b6b', fontSize: 13, marginTop: 8 }} role="alert" aria-live="polite">{error}</p>
      )}
      <button
        type="submit"
        disabled={otpAvailable ? !otpVerified : false}
        style={{
          opacity: otpAvailable ? (otpVerified ? 1 : 0.5) : 1,
          cursor: otpAvailable ? (otpVerified ? 'pointer' : 'not-allowed') : 'pointer',
        }}
      >
        Next
      </button>
    </form>
  );
}
