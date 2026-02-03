"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFirebaseAuth } from "../../../lib/firebaseClient";
import {
  KycStatusCard,
  type KycStatusPayload,
} from "../../../components/KycStatusCard";
import {
  generateAadhaarOtp,
  verifyAadhaarOtp,
  getAadhaarPortrait,
  startFaceMatch,
} from "../../../lib/kyc";

interface Step3Props {
  formData: any;
  updateFormData: (data: any) => void;
  nextStep: () => void;
  prevStep: () => void;
}

type KycStatus = KycStatusPayload & {
  nameMatchPanProfile?: number | null;
  nameMatchUpiProfile?: number | null;
  nameMatchUpiPan?: number | null;
  faceMatchStatus?: string | null;
  faceMatchScore?: number | null;
};

function friendlyError(message: string | null | undefined): string {
  const fallback = "We couldn't reach Cashfree right now. Please try again shortly.";
  if (!message) return fallback;
  const normalized = message.toString().trim();
  const match = normalized.match(/cashfree_error_(\d{3})/i);
  if (match) {
    const code = match[1];
    switch (code) {
      case "404":
        return "Cashfree's verification endpoint is temporarily unavailable. Wait a couple of minutes, then hit Start again.";
      case "400":
        return "Cashfree rejected the request. Double-check your PAN/UPI selections and retry.";
      case "401":
      case "403":
        return "Your Cashfree session expired. Refresh Step 1 (phone verification) and try again.";
      case "429":
        return "Cashfree rate-limited the request. Please retry after a short pause.";
      default:
        return `Cashfree responded with an unexpected error (${code}). Please retry in a minute.`;
    }
  }
  if (/provider_not_configured/i.test(normalized)) {
    return "Cashfree credentials are missing. Contact support so we can resolve this quickly.";
  }
  if (/missing_auth|invalid_auth/i.test(normalized)) {
    return "Your session expired. Please re-verify your phone in Step 1 and try again.";
  }
  return normalized || fallback;
}

export default function Step3_KycAndPayouts({ formData, updateFormData, nextStep, prevStep }: Step3Props) {
  // Phase-1 decision: keep onboarding fast and ops-led. We capture payout intent now and complete verification after admin approval.
  // This avoids a hard dependency on external KYC providers for Phase-1 go-live.
  const PHASE1_KYC_BYPASS = true;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<KycStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const [payoutIntent, setPayoutIntent] = useState<string | null>(formData?.payoutSetupIntent || null);
  const [aadhaarNumber, setAadhaarNumber] = useState('');
  const [aadhaarRef, setAadhaarRef] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [portraitB64, setPortraitB64] = useState<string | null>(null);
  const [selfieB64, setSelfieB64] = useState<string | null>(null);
  const [faceResult, setFaceResult] = useState<string | null>(null);
  const [faceScore, setFaceScore] = useState<number | null>(null);
  const [otpLoading, setOtpLoading] = useState(false);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [portraitLoading, setPortraitLoading] = useState(false);
  const [faceLoading, setFaceLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [otpAttempts, setOtpAttempts] = useState(0);
  const [faceAttempts, setFaceAttempts] = useState(0);
  const [showAadhaarModal, setShowAadhaarModal] = useState(false);
  const OTP_LIMIT = 3;
  const FACE_LIMIT = 2;
  const enableLocalFaceMatch = process.env.NEXT_PUBLIC_ENABLE_LOCAL_FACE_MATCH === 'true';
  const faceDone = faceResult === 'YES' || (status?.faceMatchStatus || '').toLowerCase() === 'success';
  const aadhaarDone = !!status?.aadhaarVerified;
  const faceFailed = faceAttempts >= FACE_LIMIT && !faceDone;
  const otpFailed = otpAttempts >= OTP_LIMIT && !aadhaarDone;
  const allDone = aadhaarDone && faceDone;
  const progressPercent = Math.min(100, (aadhaarDone ? 50 : 0) + (faceDone ? 50 : 0));
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [streaming, setStreaming] = useState(false);

  const fileToBase64 = useCallback(async (file: File) => {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string)?.split(',').pop() || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }, []);

  const auth = getFirebaseAuth();
  // Prefer same-origin Hosting rewrites to avoid CORS, fallback to Functions URL
  const { apiBase, functionsBase } = useMemo(() => {
    let apiBase = '/api';
    try {
      if (typeof window !== 'undefined' && window.location && window.location.origin) {
        apiBase = `${window.location.origin}/api`;
      }
    } catch (_) { /* noop */ }
    const functionsBase = (process.env.NEXT_PUBLIC_FUNCTIONS_BASE_URL || 'https://asia-south1-kalaqaar-1cd70.cloudfunctions.net').replace(/\/$/, '');
    return { apiBase, functionsBase };
  }, []);

  const fetchStatus = useCallback(async () => {
    if (PHASE1_KYC_BYPASS) {
      setStatus({
        kycStatus: 'phase1_bypass',
        checks: [],
      } as any);
      return;
    }
    if (!auth?.currentUser) return;
    const idToken = await auth.currentUser.getIdToken();
    // Try same-origin endpoint first, fallback to direct function (useful outside Hosting)
    const statusUrl = `${apiBase}/kyc/status`;
    let resp = await fetch(statusUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${idToken}` },
    });
    if (!resp.ok) {
      resp = await fetch(`${functionsBase}/getKycStatus`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${idToken}` },
      });
    }
    if (!resp.ok) return;
    const data = await resp.json();
    if (data?.ok && data.status) setStatus(data.status as KycStatus);
  }, [auth?.currentUser, apiBase, functionsBase]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    // If returning from Cashfree redirect, show a toast-like state by reading the query param.
    if (typeof window !== 'undefined' && window.location.search.includes('kyc=')) {
      setTimeout(() => { fetchStatus(); }, 500);
    }
  }, [fetchStatus]);

  useEffect(() => {
    // Poll until verified or after starting session
    if (!polling) return;
    const t = setInterval(() => { fetchStatus(); }, 3000);
    return () => clearInterval(t);
  }, [polling, fetchStatus]);

  // Calculate kycComplete before using it in useEffect
  const kycComplete = Boolean(status && ['verified', 'completed'].includes((status.kycStatus || '').toLowerCase()));

  const verificationState = useMemo(() => {
    if (PHASE1_KYC_BYPASS) {
      return {
        complete: true,
        message: 'Phase 1: verification will be completed by KalaQaar after approval.',
        missing: [] as string[],
      };
    }
    const requiredChecks = Array.isArray(status?.checks) && status.checks.length > 0
      ? status.checks.map((c) => String(c).toLowerCase())
      : null;

    const missing: string[] = [];
    if (requiredChecks) {
      if (requiredChecks.includes('pan') && !status?.panVerified) missing.push('PAN');
      if (requiredChecks.includes('upi') && !status?.upiVerified) missing.push('UPI');
      if (requiredChecks.includes('bank') && !status?.bankVerified) missing.push('Bank');
      if (requiredChecks.includes('aadhaar') && !status?.aadhaarVerified) missing.push('Aadhaar');
    }

    const requiredChecksComplete = requiredChecks ? missing.length === 0 : false;
    const complete = kycComplete || requiredChecksComplete;

    const normalized = (status?.kycStatus || '').toLowerCase();
    const needsAttention = ['failed', 'rejected'].includes(normalized);

    let message: string | null = null;
    if (!status) {
      message = 'Checking verification status…';
    } else if (complete) {
      message = 'Verification complete.';
    } else if (needsAttention) {
      message = 'Verification needs attention. Please restart and complete the checks.';
    } else if (missing.length) {
      message = `Complete ${missing.join(', ')} verification to continue.`;
    } else {
      message = 'Complete verification to continue.';
    }

    return { complete, message, missing };
  }, [PHASE1_KYC_BYPASS, kycComplete, status]);

  useEffect(() => {
    if (!polling) return;
    if (kycComplete || allDone) setPolling(false);
  }, [polling, kycComplete, allDone]);

  // Auto-dismiss toast after 5s
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const resetAadhaarFlow = useCallback(() => {
    setAadhaarNumber('');
    setAadhaarRef(null);
    setOtp('');
    setSelfieB64(null);
    setPortraitB64(null);
    setFaceResult(null);
    setFaceScore(null);
    setOtpAttempts(0);
    setFaceAttempts(0);
    setOtpLoading(false);
    setVerifyLoading(false);
    setPortraitLoading(false);
    setFaceLoading(false);
    setToast(null);
    setError(null);
    setPolling(false);
  }, []);

  // Camera preview start/stop
  const startCamera = useCallback(async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      const videoEl = videoRef.current;
      if (videoEl) {
        videoEl.srcObject = stream;
        videoEl.play();
        setStreaming(true);
      }
    } catch (e: any) {
      setCameraError(e?.message || 'Unable to access camera');
    }
  }, []);

  const stopCamera = useCallback(() => {
    const videoEl = videoRef.current;
    if (videoEl && videoEl.srcObject) {
      const tracks = (videoEl.srcObject as MediaStream).getTracks();
      tracks.forEach((t) => t.stop());
      videoEl.srcObject = null;
    }
    setStreaming(false);
  }, []);

  useEffect(() => {
    if (!showAadhaarModal) {
      stopCamera();
      resetAadhaarFlow();
    }
    return () => stopCamera();
  }, [showAadhaarModal, stopCamera, resetAadhaarFlow]);

  const captureSelfie = useCallback(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth || 640;
    canvas.height = videoEl.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg');
    const b64 = dataUrl.split(',').pop() || '';
    setSelfieB64(b64);
    setToast('Selfie captured.');
  }, []);

  async function startKyc(checks?: { pan?: boolean; upi?: boolean; bank?: boolean; aadhaar?: boolean }) {
    try {
      setError(null);
      setLoading(true);
      if (!auth?.currentUser) throw new Error('Please verify your phone in Step 1 first.');
      const idToken = await auth.currentUser.getIdToken();
      const applicantPhone = formData?.phoneNumber || formData?.phone || auth.currentUser.phoneNumber;
      if (!applicantPhone) {
        throw new Error('Phone number missing from profile. Complete Step 1 again.');
      }
      const applicantName = formData?.legalName || formData?.displayName || formData?.name || auth.currentUser.displayName || 'Kalaqaar Artist';
      const applicantEmail = (formData?.email || auth.currentUser.email || '').trim();
      const templateName = formData?.kycTemplate || 'Verification_kalaqaar';
      const payload = {
        // Default to PAN + Aadhaar + Bank (no UPI)
        ...(checks || { pan: true, upi: false, bank: true, aadhaar: true }),
        phone: applicantPhone,
        email: applicantEmail || undefined,
        name: applicantName,
        template_name: templateName,
      };
      // Try same-origin endpoint first, fallback to direct function
      const startUrl = `${apiBase}/kyc/session`;
      let resp = await fetch(startUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        resp = await fetch(`${functionsBase}/createKycSession`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify(payload),
        });
      }
      const data = await resp.json();
      if (!resp.ok || !data?.ok || !data?.link_url) throw new Error(data?.error || 'Failed to start verification');
      setPayoutIntent('started');
      updateFormData({ payoutSetupIntent: 'started' });
      setPolling(true);
      // Redirect to Cashfree hosted page
      window.location.href = data.link_url;
    } catch (e: any) {
      setError(friendlyError(e?.message));
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerateOtp() {
    try {
      setError(null);
      setOtpLoading(true);
      const r = await generateAadhaarOtp(aadhaarNumber.trim());
      setAadhaarRef(r.refId);
      setPolling(true);
      setToast('OTP sent. Check your registered mobile and enter it below.');
      setOtpAttempts((n) => n + 1);
    } catch (e: any) {
      setError(friendlyError(e?.message));
    } finally {
      setOtpLoading(false);
    }
  }

  async function handleVerifyOtp() {
    if (!aadhaarRef) { setError('Generate OTP first'); return; }
    try {
      setError(null);
      setVerifyLoading(true);
      const r = await verifyAadhaarOtp(otp.trim(), aadhaarRef);
      if (r.verified) {
        let portraitFetched = false;
        setPortraitLoading(true);
        try {
          const portrait = await getAadhaarPortrait();
          portraitFetched = Boolean(portrait?.portrait_base64);
          setPortraitB64(portrait?.portrait_base64 || null);
        } catch (portraitErr: any) {
          setError(friendlyError(portraitErr?.message));
        } finally {
          setPortraitLoading(false);
        }
        fetchStatus();
        setToast(portraitFetched ? 'Aadhaar verified. Portrait fetched—now run face match.' : 'Aadhaar verified. Portrait not available yet—upload/capture selfie and fetch again.');
        setOtpAttempts(0);
      }
    } catch (e: any) {
      setError(friendlyError(e?.message));
    } finally {
      setVerifyLoading(false);
    }
  }

  async function handleFaceMatch() {
    if (!selfieB64 || !portraitB64) {
      setError('Capture selfie and fetch portrait first');
      return;
    }
    try {
      setError(null);
      setFaceLoading(true);
      const r = await startFaceMatch(selfieB64, portraitB64);
      setFaceResult(r.result || (r.matched ? 'YES' : 'NO'));
      setFaceScore(r.score || null);
      fetchStatus();
      setToast(r.matched ? 'Face match success.' : 'Face match failed. Please retry or contact support.');
      setFaceAttempts((n) => n + 1);
    } catch (e: any) {
      setError(friendlyError(e?.message));
    } finally {
      setFaceLoading(false);
    }
  }

  const handleContinue = useCallback(() => {
    if (!verificationState.complete) {
      setError(verificationState.message);
      return;
    }
    const intent: 'ready' = 'ready';
    setPayoutIntent(intent);
    updateFormData({
      kycStatus: PHASE1_KYC_BYPASS ? 'pending' : (status?.kycStatus || 'pending'),
      payoutSetupIntent: intent,
      payoutSetupNotedAt: new Date().toISOString(),
    });
    nextStep();
  }, [PHASE1_KYC_BYPASS, nextStep, status?.kycStatus, updateFormData, verificationState.complete, verificationState.message]);

  return (
    <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
      <div>
        <h2 style={{ margin: '0 0 8px' }}>Payout setup</h2>
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.9375rem', lineHeight: 1.6 }}>
          Phase 1: KalaQaar will complete verification after approval. You can continue now to submit your application.
        </p>
      </div>

      <KycStatusCard
        status={status}
        loading={loading}
        error={error}
        onStartKyc={PHASE1_KYC_BYPASS ? undefined : (kycComplete ? undefined : () => startKyc())}
        onRefresh={() => fetchStatus()}
        showActions={!PHASE1_KYC_BYPASS && !kycComplete}
      />

      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {verificationState.message || (PHASE1_KYC_BYPASS
          ? 'You can continue. KalaQaar will verify after approval.'
          : "Verification is handled directly by Cashfree’s hosted flow. Status updates automatically after checks complete.")}
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
        <button type="button" onClick={prevStep} className="button-secondary" style={{ flex: '1 1 140px' }}>
          Back
        </button>
        <button
          type="button"
          className="button-primary"
          onClick={handleContinue}
          style={{ flex: '2 1 220px' }}
          disabled={!verificationState.complete}
        >
          Continue
        </button>
      </div>

      <p style={{ fontSize: 12, opacity: 0.7, textAlign: 'center', marginTop: 8 }}>
        🔒 Phase 1: verification is completed after approval. We store only verification status and masked values.
      </p>

    </div>
  );
}
