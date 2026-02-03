"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { generateArtistBio, analyzePortfolioImage, type ImageQualityResult } from "../../../lib/api";
import { uploadPortfolioMedia, type UploadedPortfolioItem } from "../../../lib/storage";
import { validateSocialLink } from "../../../lib/socialValidation";

interface Step2Props {
  formData: any;
  updateFormData: (data: any) => void;
  nextStep: () => void;
  prevStep: () => void;
}

const MAX_PORTFOLIO_ITEMS = 8;
const MIN_PORTFOLIO_ITEMS = 3;
const MIN_BIO_CHARACTERS = 100;
const MAX_PORTFOLIO_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB limit enforced by Storage rules

type PortfolioStatus = "uploading" | "done" | "error";

type PortfolioEntry = {
  id: string;
  status: PortfolioStatus;
  progress?: number;
  error?: string;
  external?: boolean;
  quality?: ImageQualityResult;
  description?: string;
} & Partial<UploadedPortfolioItem>;

function normalizeEntries(entries: unknown): PortfolioEntry[] {
  if (!Array.isArray(entries)) return [];
  const result: PortfolioEntry[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Record<string, unknown>;
    const id = candidate.id;
    if (!id) continue;
    result.push({
      id: String(id),
      status: (candidate.status as PortfolioStatus) ?? "done",
      progress: typeof candidate.progress === "number" ? candidate.progress : undefined,
      error: candidate.error ? String(candidate.error) : undefined,
      url: typeof candidate.url === "string" ? candidate.url : undefined,
      storagePath: typeof candidate.storagePath === "string" ? candidate.storagePath : undefined,
      type: candidate.type === "video" ? "video" : candidate.type === "image" ? "image" : undefined,
      thumbnail: typeof candidate.thumbnail === "string" ? candidate.thumbnail : null,
      external: candidate.external === true,
      quality: candidate.quality as ImageQualityResult | undefined,
    });
  }
  return result;
}

export default function Step2_ProfileAndPortfolio({ formData, updateFormData, nextStep, prevStep }: Step2Props) {
  const [mounted, setMounted] = useState(false);
  const [bio, setBio] = useState<string>(formData.bio || "");
  const [bioSuggestions, setBioSuggestions] = useState<string[]>([]);
  const [bioGenerating, setBioGenerating] = useState(false);
  const [profilePhoto, setProfilePhoto] = useState<string | null>(formData.profilePhoto || null);
  const [profilePhotoUploading, setProfilePhotoUploading] = useState(false);
  const [portfolioEntries, setPortfolioEntries] = useState<PortfolioEntry[]>(() => normalizeEntries(formData.portfolioEntries));
  const [portfolioUploading, setPortfolioUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [socialLinks, setSocialLinks] = useState<Record<string, string>>(() => ({
    instagram: typeof formData?.social?.instagram === 'string' ? formData.social.instagram : '',
    youtube: typeof formData?.social?.youtube === 'string' ? formData.social.youtube : '',
    spotify: typeof formData?.social?.spotify === 'string' ? formData.social.spotify : '',
    twitter: typeof formData?.social?.twitter === 'string' ? formData.social.twitter : '',
  }));
  const [socialStatuses, setSocialStatuses] = useState<Record<string, 'idle' | 'validating' | 'valid' | 'invalid'>>({
    instagram: 'idle',
    youtube: 'idle',
    spotify: 'idle',
    twitter: 'idle',
  });
  const [newLinkUrl, setNewLinkUrl] = useState<string>("");
  const [newLinkError, setNewLinkError] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadControllersRef = useRef<Record<string, AbortController>>({});
  const socialDebounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const socialAbortRef = useRef<Record<string, AbortController>>({});

  const completedEntries = useMemo(
    () => (portfolioEntries || []).filter((entry) => entry && entry.status === "done" && entry.url),
    [portfolioEntries],
  );

  const bioLength = useMemo(() => bio.trim().length, [bio]);
  const trustedHosts = useMemo(() => ['instagram.com', 'youtube.com', 'behance.net', 'vimeo.com', 'drive.google.com'], []);

  const watermarkHelp = "KalaQaar automatically applies a discreet watermark before your media appears to clients. You’ll always keep the original high-resolution files.";

  const persistDraft = useCallback((partial: Partial<{ bio: string; profilePhoto: string | null; portfolioEntries: PortfolioEntry[]; social: Record<string, string> }>) => {
    updateFormData(partial);
  }, [updateFormData]);

  const setBioAndSync = useCallback((value: string) => {
    setBio(value);
    persistDraft({ bio: value });
  }, [persistDraft]);

  const setProfilePhotoAndSync = useCallback((value: string | null) => {
    setProfilePhoto(value);
    persistDraft({ profilePhoto: value });
  }, [persistDraft]);

  const updatePortfolioEntries = useCallback((updater: (prev: PortfolioEntry[]) => PortfolioEntry[]) => {
    setPortfolioEntries((prev) => {
      const next = updater(prev);
      persistDraft({ portfolioEntries: next });
      return next;
    });
  }, [persistDraft]);

  const updateSocialLink = useCallback((platform: 'instagram' | 'youtube' | 'spotify' | 'twitter', value: string) => {
    setSocialLinks((prev) => ({ ...prev, [platform]: value }));
    setSocialStatuses((prev) => ({ ...prev, [platform]: value ? 'validating' : 'idle' }));
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    persistDraft({ social: socialLinks });
  }, [persistDraft, socialLinks]);

  useEffect(() => {
    let active = true;
    Object.entries(socialLinks).forEach(([platform, link]) => {
      const typedPlatform = platform as 'instagram' | 'youtube' | 'spotify' | 'twitter';

      if (socialDebounceRef.current[typedPlatform]) {
        clearTimeout(socialDebounceRef.current[typedPlatform]);
        delete socialDebounceRef.current[typedPlatform];
      }

      if (socialAbortRef.current[typedPlatform]) {
        socialAbortRef.current[typedPlatform].abort();
        delete socialAbortRef.current[typedPlatform];
      }

      if (!link) {
        setSocialStatuses((prev) => ({ ...prev, [typedPlatform]: 'idle' }));
        setFieldErrors((prev) => ({ ...prev, [typedPlatform]: '' }));
        return;
      }

      setSocialStatuses((prev) => ({ ...prev, [typedPlatform]: 'validating' }));

      socialDebounceRef.current[typedPlatform] = setTimeout(() => {
        if (!active) return;
        const controller = new AbortController();
        socialAbortRef.current[typedPlatform] = controller;
        validateSocialLink(typedPlatform, link, controller.signal)
          .then((result) => {
            if (!active) return;
            setSocialStatuses((prev) => ({ ...prev, [typedPlatform]: result.ok ? 'valid' : 'invalid' }));
            setFieldErrors((prev) => ({ ...prev, [typedPlatform]: result.ok ? '' : (result.reason || 'Invalid link') }));
          })
          .catch((err) => {
            if (err?.name === 'AbortError' || !active) return;
            const message = err?.status === 429
              ? 'Too many attempts. Please pause for a moment.'
              : 'Unable to validate link right now';
            setSocialStatuses((prev) => ({ ...prev, [typedPlatform]: 'invalid' }));
            setFieldErrors((prev) => ({ ...prev, [typedPlatform]: message }));
          })
          .finally(() => {
            delete socialAbortRef.current[typedPlatform];
          });
      }, 600);
    });

    return () => {
      active = false;
      Object.values(socialDebounceRef.current).forEach((timeoutId) => clearTimeout(timeoutId));
      socialDebounceRef.current = {};
      Object.values(socialAbortRef.current).forEach((controller) => controller.abort());
      socialAbortRef.current = {};
    };
  }, [socialLinks]);

  const handleGenerateBio = useCallback(async () => {
    try {
      setBioGenerating(true);
      const options = {
        displayName: formData?.name || undefined,
        category: formData?.categoryKey || undefined,
        city: formData?.cityKey || undefined,
      } as any;
      const suggestions = await generateArtistBio(options);
      setBioSuggestions(suggestions);
      if (!bio && suggestions[0]) setBioAndSync(suggestions[0]);
    } catch (e: any) {
      setError(e?.message || "Failed to generate bio");
    } finally {
      setBioGenerating(false);
    }
  }, [bio, formData?.categoryKey, formData?.cityKey, formData?.name, setBioAndSync]);

  const handlePortfolioButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const removePortfolioEntry = useCallback((id: string) => {
    updatePortfolioEntries((prev) => prev.filter((entry) => entry.id !== id));
    const ctrl = uploadControllersRef.current[id];
    if (ctrl) ctrl.abort();
    delete uploadControllersRef.current[id];
  }, [updatePortfolioEntries]);

  const handleProfilePhotoUpload = useCallback(async (file: File) => {
    setError(null);
    setProfilePhotoUploading(true);
    // Create preview immediately
    const previewUrl = URL.createObjectURL(file);
    setProfilePhotoAndSync(previewUrl); // Keep preview visible
    try {
      const uploaded = await uploadPortfolioMedia(file);
      setProfilePhotoAndSync(uploaded.url);
      setFieldErrors((prev) => ({ ...prev, profilePhoto: '' }));
      URL.revokeObjectURL(previewUrl); // Clean up preview after successful upload
    } catch (e: any) {
      setError(e?.message || "Failed to upload photo");
      // Keep the preview URL so user can see what they selected, even if upload failed
      // Don't clear it - let them manually remove if needed
      setFieldErrors((prev) => ({ ...prev, profilePhoto: e?.message || 'Upload failed' }));
    } finally {
      setProfilePhotoUploading(false);
    }
  }, [setProfilePhotoAndSync]);

  const handlePortfolioSelected = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    setError(null);
    setPortfolioUploading(true);
    try {
      const skipped: string[] = [];
      for (const file of files) {
        if (file.size > MAX_PORTFOLIO_FILE_SIZE_BYTES) {
          skipped.push(file.name);
          continue;
        }
        const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const ctrl = new AbortController();
        uploadControllersRef.current[id] = ctrl;
        updatePortfolioEntries((prev) => [...prev, { id, status: 'uploading', progress: 0 }]);
        try {
          const uploaded = await uploadPortfolioMedia(file, {
            onProgress: (p) => {
              updatePortfolioEntries((prev) => prev.map((e) => (e.id === id ? { ...e, progress: p } : e)));
            },
            signal: ctrl.signal,
          });
          updatePortfolioEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...uploaded, status: 'done' } : e)));

          // Trigger AI analysis for images
          if (uploaded.type === 'image' && uploaded.url) {
            analyzePortfolioImage(uploaded.url, {
              comprehensive: true,
              artistContext: {
                displayName: formData.displayName || formData.name,
                category: formData.categoryKey || formData.category,
              }
            }).then((quality) => {
              updatePortfolioEntries((prev) => prev.map((e) => (e.id === id ? {
                ...e,
                quality,
                description: e.description || quality.description
              } : e)));
            }).catch(console.error);
          }
        } catch (err: any) {
          updatePortfolioEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status: 'error', error: err?.message || 'Upload failed' } : e)));
        } finally {
          delete uploadControllersRef.current[id];
        }
      }
      if (skipped.length) {
        setError(`Skipped ${skipped.length} file${skipped.length > 1 ? 's' : ''} over 10MB: ${skipped.join(', ')}`);
      }
    } finally {
      setPortfolioUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [updatePortfolioEntries]);

  const allowedExternalHosts = useMemo(() => [
    'youtube.com', 'www.youtube.com', 'youtu.be',
    'vimeo.com', 'www.vimeo.com',
    'drive.google.com',
    'dropbox.com', 'www.dropbox.com',
    'googlephotos.com', 'photos.google.com',
    'instagram.com', 'www.instagram.com',
    'behance.net', 'www.behance.net'
  ], []);

  const validateExternalLink = useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, reason: 'Link required' };
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'https:') {
        return { ok: false, reason: 'Use https:// links only' };
      }
      const host = url.hostname.toLowerCase();
      const ok = allowedExternalHosts.some((domain) => host === domain || host.endsWith(`.${domain}`));
      if (!ok) {
        return { ok: false, reason: 'Link must be from YouTube, Vimeo, Instagram, Behance, Google Drive, or Dropbox' };
      }
      return { ok: true, normalized: url.toString() };
    } catch (_) {
      return { ok: false, reason: 'Enter a valid https:// link' };
    }
  }, [allowedExternalHosts]);

  const handleAddExternalLink = useCallback(() => {
    const result = validateExternalLink(newLinkUrl);
    if (!result.ok) {
      setNewLinkError(result.reason || 'Invalid link');
      return;
    }
    if (portfolioEntries.length >= MAX_PORTFOLIO_ITEMS) {
      setNewLinkError(`Limit of ${MAX_PORTFOLIO_ITEMS} items reached. Remove an item before adding another.`);
      return;
    }
    const id = `link-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const entry: PortfolioEntry = {
      id,
      status: 'done',
      url: result.normalized || newLinkUrl.trim(),
      type: 'video',
      external: true,
    };
    updatePortfolioEntries((prev) => [...prev, entry]);
    setNewLinkUrl('');
    setNewLinkError('');
  }, [newLinkUrl, portfolioEntries.length, updatePortfolioEntries, validateExternalLink]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};

    const completedEntries = (portfolioEntries || []).filter(
      (entry: PortfolioEntry) => entry && entry.status === "done" && entry.url
    );

    if (!bio || bio.trim().length < MIN_BIO_CHARACTERS) {
      nextErrors.bio = `Bio must be at least ${MIN_BIO_CHARACTERS} characters.`;
    }
    if (!profilePhoto) {
      nextErrors.profilePhoto = "Profile photo is required.";
    }
    if (completedEntries.length < MIN_PORTFOLIO_ITEMS) {
      nextErrors.portfolio = `Upload at least ${MIN_PORTFOLIO_ITEMS} completed portfolio items.`;
    }

    const socialValues = Object.values(socialLinks).filter(Boolean);
    const invalidSocial = Object.entries(socialStatuses).find(([, status]) => status === 'invalid');
    if (invalidSocial) {
      nextErrors.social = "Fix invalid social links before continuing.";
    }

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      return;
    }

    updateFormData({ bio, profilePhoto, portfolioEntries, social: socialLinks });
    nextStep();
  };

  if (!mounted) {
    return (
      <div style={{ padding: '2rem 0', textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
        Loading your saved profile details…
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12, marginTop: 16 }}>
      <section
        style={{
          display: 'grid',
          gap: 12,
          padding: '1rem',
          borderRadius: 12,
          border: '1px solid rgba(148,163,184,0.25)',
          background: 'rgba(148,163,184,0.08)',
        }}
        aria-live="polite"
      >
        <strong style={{ fontSize: 14 }}>Progress at a glance</strong>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <div style={{ padding: '0.75rem', borderRadius: 10, background: 'rgba(30,64,175,0.25)', border: '1px solid rgba(59,130,246,0.25)' }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Bio</div>
            <div style={{ fontWeight: 600 }}>{bioLength}/{MIN_BIO_CHARACTERS} characters</div>
          </div>
          <div style={{ padding: '0.75rem', borderRadius: 10, background: 'rgba(22,101,52,0.25)', border: '1px solid rgba(34,197,94,0.25)' }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Portfolio items</div>
            <div style={{ fontWeight: 600 }}>{completedEntries.length}/{MIN_PORTFOLIO_ITEMS} uploaded</div>
          </div>
          <div style={{ padding: '0.75rem', borderRadius: 10, background: 'rgba(180,83,9,0.25)', border: '1px solid rgba(251,191,36,0.25)' }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Profile photo</div>
            <div style={{ fontWeight: 600 }}>{profilePhoto ? 'Ready ✅' : 'Missing'}</div>
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 12, color: 'rgba(226,232,240,0.9)' }}>
          Tip: Trusted hosts such as Instagram, YouTube, and Behance help us auto-approve your profile faster.
        </p>
      </section>
      <div>
        <label htmlFor="bio" style={{ display: "block", marginBottom: 6 }}>Short bio * (required for listing)</label>
        <textarea
          id="bio"
          required
          value={bio}
          onChange={(e) => { setBio(e.target.value); setFieldErrors(prev => ({ ...prev, bio: '' })); }}
          placeholder="100-300 characters about your experience and style (required)"
          rows={4}
          aria-invalid={!!fieldErrors.bio}
          style={{
            width: "100%",
            padding: "0.75rem",
            borderRadius: 8,
            border: fieldErrors.bio ? "1px solid #ff6b6b" : "1px solid rgba(255,255,255,0.12)",
            background: "transparent",
            color: "inherit",
          }}
        />
        {fieldErrors.bio && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.bio}</p>}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handleGenerateBio}
            disabled={bioGenerating}
            style={{
              padding: "0.65rem 1.25rem",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.2)",
              background: bioGenerating ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.08)",
              color: "inherit",
              cursor: bioGenerating ? "not-allowed" : "pointer",
            }}
          >
            {bioGenerating ? "Generating…" : "Generate with AI"}
          </button>
          <small style={{ opacity: 0.75 }}>AI suggestions keep it concise and client-ready. Min 100 characters required.</small>
        </div>
        {bioSuggestions.length > 0 && (
          <div style={{ marginTop: 12, padding: "0.75rem", borderRadius: 10, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.03)", display: "grid", gap: 8 }}>
            <strong style={{ fontSize: 13, opacity: 0.85 }}>AI suggestions</strong>
            {bioSuggestions.map((suggestion, index) => (
              <button
                type="button"
                key={`bio-suggestion-${index}`}
                onClick={() => setBio(suggestion)}
                style={{
                  textAlign: "left",
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.18)",
                  borderRadius: 8,
                  padding: "0.75rem",
                  color: "inherit",
                  cursor: "pointer",
                }}
              >
                {suggestion}
              </button>
            ))}
            <small style={{ opacity: 0.7 }}>Click a suggestion to use it, then tweak if you’d like.</small>
          </div>
        )}
      </div>

      <div style={{
        margin: "1.5rem 0",
        padding: "1rem",
        borderRadius: 8,
        background: "var(--card-bg, rgba(255,255,255,0.04))",
        border: "1px solid rgba(255,255,255,0.08)",
      }}>
        <h3 style={{ marginTop: 0 }}>Profile Photo * (required for listing)</h3>
        <p style={{ opacity: 0.75, fontSize: 13, marginBottom: 16 }}>
          Upload a clear, professional photo of yourself. This helps clients recognize you.
        </p>
        {profilePhoto ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <img
              src={profilePhoto}
              alt="Profile"
              style={{
                width: 120,
                height: 120,
                objectFit: 'cover',
                borderRadius: '50%',
                border: '2px solid rgba(255,255,255,0.2)'
              }}
            />
            <div>
              <p style={{ marginBottom: 8, color: '#34d399' }}>✓ Photo uploaded</p>
              <button
                type="button"
                onClick={() => setProfilePhoto(null)}
                style={{
                  padding: '0.5rem 1rem',
                  borderRadius: 6,
                  border: '1px solid rgba(255,100,100,0.3)',
                  background: 'rgba(255,100,100,0.1)',
                  color: '#ff6b6b',
                  cursor: 'pointer',
                }}
              >
                Remove Photo
              </button>
            </div>
          </div>
        ) : (
          <div>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  if (file.size > 10 * 1024 * 1024) {
                    setError('Photo must be less than 10MB');
                    return;
                  }
                  handleProfilePhotoUpload(file);
                }
              }}
              style={{ display: 'none' }}
              id="profile-photo-input"
              disabled={profilePhotoUploading}
            />
            <label
              htmlFor="profile-photo-input"
              style={{
                display: 'inline-block',
                padding: '0.75rem 1.5rem',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.2)',
                background: profilePhotoUploading ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.08)',
                cursor: profilePhotoUploading ? 'not-allowed' : 'pointer',
                color: 'inherit',
              }}
            >
              {profilePhotoUploading ? 'Uploading...' : '📷 Upload Profile Photo'}
            </label>
            <p style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
              JPG, PNG, or WebP. Max 10MB. Square photos work best.
            </p>
            {fieldErrors.profilePhoto && (
              <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.profilePhoto}</p>
            )}
          </div>
        )}
      </div>

      <div>
        <h3 style={{ margin: '12px 0 6px' }}>Portfolio media * (required for listing)</h3>
        <p style={{ opacity: 0.75, fontSize: 13, marginBottom: 12 }}>
          Upload at least 3 photos or short videos (up to {MAX_PORTFOLIO_ITEMS} total).
        </p>
        <div style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          fontSize: 12,
          padding: '8px 12px',
          borderRadius: 8,
          border: '1px solid rgba(148,163,184,0.18)',
          background: 'rgba(148,163,184,0.08)',
          color: 'rgba(226,232,240,0.9)',
          marginBottom: 14,
        }}>
          <span aria-hidden="true" style={{ fontSize: 16 }}>🛡️</span>
          <span>{watermarkHelp}</span>
        </div>
        {completedEntries.length < MIN_PORTFOLIO_ITEMS && (
          <p style={{ color: '#fbbf24', fontSize: 13, marginBottom: 12 }}>
            ⚠️ {Math.max(0, MIN_PORTFOLIO_ITEMS - completedEntries.length)} more item(s) needed to complete your profile
          </p>
        )}
        {fieldErrors.portfolio && <p style={{ color: '#ff6b6b', fontSize: 12, marginBottom: 8 }}>{fieldErrors.portfolio}</p>}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={handlePortfolioButtonClick}
            disabled={portfolioUploading}
            style={{
              padding: "0.7rem 1.4rem",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.2)",
              background: portfolioUploading ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.08)",
              color: "inherit",
              cursor: portfolioUploading ? "progress" : "pointer",
            }}
          >
            {portfolioUploading ? "Uploading…" : "Upload photo / video"}
          </button>
          <small style={{ opacity: 0.7 }}>Accepted: JPG, PNG, WebP (each up to 10MB).</small>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          style={{ display: "none" }}
          multiple
          onChange={handlePortfolioSelected}
        />
        {portfolioEntries.length > 0 && (
          <div style={{ marginTop: 16, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
            {portfolioEntries.map((entry) => (
              <div key={entry.id} style={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: 10, position: 'relative', background: 'rgba(255,255,255,0.03)' }}>
                <div style={{ position: 'relative', paddingBottom: '60%', borderRadius: 8, overflow: 'hidden', background: 'rgba(255,255,255,0.08)' }}>
                  {entry.url ? (
                    entry.external ? (
                      <a
                        href={entry.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: '#93c5fd', textDecoration: 'underline', fontSize: 13, padding: '0 12px', textAlign: 'center'
                        }}
                      >
                        Open hosted media ↗
                      </a>
                    ) : entry.type === 'video' ? (
                      <video src={entry.url} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} controls={false} muted />
                    ) : (
                      <img src={entry.url} alt="Portfolio preview" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                    )
                  ) : (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, opacity: 0.7 }}>
                      {entry.status === 'uploading' ? 'Uploading…' : 'Preview unavailable'}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                  <span style={{ fontSize: 12, opacity: 0.75, textTransform: 'uppercase' }}>{entry.type}</span>
                  <button
                    type="button"
                    onClick={() => removePortfolioEntry(entry.id)}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'rgba(255,255,255,0.7)',
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    Remove
                  </button>
                </div>
                {entry.status === 'uploading' && (
                  <div style={{ marginTop: 6, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 999 }}>
                    <div style={{ width: `${entry.progress}%`, height: '100%', background: 'rgba(255,255,255,0.6)', borderRadius: 999 }} />
                  </div>
                )}
                {entry.status === 'error' && (
                  <div style={{ marginTop: 6, fontSize: 12, color: '#ff8a8a' }}>{entry.error || 'Upload failed'}</div>
                )}
                {entry.status === 'done' && !entry.external && (
                  <div style={{
                    marginTop: 8,
                    padding: '6px 8px',
                    borderRadius: 6,
                    background: entry.thumbnail ? 'rgba(34,197,94,0.12)' : 'rgba(250,204,21,0.12)',
                    border: entry.thumbnail ? '1px solid rgba(34,197,94,0.25)' : '1px solid rgba(250,204,21,0.3)',
                    color: entry.thumbnail ? '#bbf7d0' : '#fde68a',
                    fontSize: 11,
                    lineHeight: 1.4,
                  }}>
                    {entry.thumbnail ? '✅ Watermark ready – clients see the protected version.' : '🪄 Watermark processing – usually ready within a few minutes.'}
                  </div>
                )}
                {entry.quality && (
                  <div style={{
                    marginTop: 4,
                    padding: '6px 8px',
                    borderRadius: 6,
                    background: entry.quality.score >= 70 ? 'rgba(34,197,94,0.1)' : entry.quality.score >= 50 ? 'rgba(251,191,36,0.1)' : 'rgba(239,68,68,0.1)',
                    border: entry.quality.score >= 70 ? '1px solid rgba(34,197,94,0.2)' : entry.quality.score >= 50 ? '1px solid rgba(251,191,36,0.2)' : '1px solid rgba(239,68,68,0.2)',
                    fontSize: 11,
                    color: entry.quality.score >= 70 ? '#86efac' : entry.quality.score >= 50 ? '#fbbf24' : '#fca5a5',
                  }}>
                    <strong>Quality Score: {entry.quality.score}/100</strong>
                    <div style={{ opacity: 0.9, marginTop: 2 }}>{entry.quality.feedback}</div>
                  </div>
                )}
                {entry.description !== undefined && (
                  <div style={{ marginTop: 8 }}>
                    <textarea
                      value={entry.description || ''}
                      onChange={(e) => updatePortfolioEntries(prev => prev.map(p => p.id === entry.id ? { ...p, description: e.target.value } : p))}
                      placeholder="Add a description..."
                      style={{
                        width: '100%',
                        fontSize: 12,
                        padding: '6px 8px',
                        borderRadius: 6,
                        border: '1px solid rgba(255,255,255,0.1)',
                        background: 'rgba(0,0,0,0.2)',
                        color: 'rgba(255,255,255,0.9)',
                        resize: 'vertical'
                      }}
                      rows={2}
                    />
                    <div style={{ fontSize: 10, opacity: 0.5, textAlign: 'right', marginTop: 2 }}>AI-generated description</div>
                  </div>
                )}
                {entry.external && (
                  <div style={{
                    marginTop: 8,
                    padding: '6px 8px',
                    borderRadius: 6,
                    background: 'rgba(147, 197, 253, 0.12)',
                    border: '1px solid rgba(147, 197, 253, 0.3)',
                    color: '#bfdbfe',
                    fontSize: 11,
                    lineHeight: 1.4,
                  }}>
                    🌐 External link – hosted media stays on your chosen platform.
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 8 }}>Add hosted media link</h3>
        <p style={{ opacity: 0.75, fontSize: 13, marginBottom: 12 }}>
          Have a reel or portfolio already online? Add a YouTube/Vimeo/Instagram/Behance/Drive/Dropbox link and we’ll include it in your profile.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="url"
            value={newLinkUrl}
            onChange={(e) => { setNewLinkUrl(e.target.value); setNewLinkError(''); }}
            placeholder="https://youtu.be/..."
            style={{
              flex: '1 1 260px',
              minWidth: 240,
              padding: '0.75rem',
              borderRadius: 8,
              border: newLinkError ? '1px solid #ff6b6b' : '1px solid rgba(255,255,255,0.12)',
              background: 'transparent',
              color: 'inherit',
            }}
          />
          <button
            type="button"
            onClick={handleAddExternalLink}
            style={{
              padding: '0.7rem 1.4rem',
              borderRadius: 999,
              border: '1px solid rgba(96,165,250,0.35)',
              background: 'rgba(96,165,250,0.15)',
              color: '#dbeafe',
              cursor: 'pointer',
            }}
          >
            Add link
          </button>
        </div>
        {newLinkError && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 6 }}>{newLinkError}</p>}
      </div>
      <div style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 8 }}>Social links</h3>
        <p style={{ opacity: 0.75, fontSize: 13, marginBottom: 12 }}>
          Share your public profiles so clients can explore more of your work. We verify each link for authenticity.
        </p>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {([
            { platform: 'instagram', label: 'Instagram URL', placeholder: 'https://instagram.com/yourhandle' },
            { platform: 'youtube', label: 'YouTube URL', placeholder: 'https://youtube.com/@channel' },
            { platform: 'spotify', label: 'Spotify artist/profile URL', placeholder: 'https://open.spotify.com/artist/...' },
            { platform: 'twitter', label: 'Twitter/X URL', placeholder: 'https://twitter.com/yourhandle' },
          ] as const).map(({ platform, label, placeholder }) => {
            const status = socialStatuses[platform];
            const value = socialLinks[platform];
            return (
              <label key={platform} style={{ display: 'grid', gap: 6 }}>
                <span>{label}</span>
                <input
                  type="url"
                  value={value}
                  onChange={(e) => updateSocialLink(platform, e.target.value)}
                  placeholder={placeholder}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: 8,
                    border: fieldErrors[platform] ? '1px solid #ff6b6b' : '1px solid rgba(255,255,255,0.12)',
                    background: 'transparent',
                    color: 'inherit',
                  }}
                />
                <span style={{ fontSize: 11, opacity: 0.7 }}>
                  {status === 'validating' && 'Checking link…'}
                  {status === 'valid' && 'Looks good ✔'}
                  {status === 'invalid' && (fieldErrors[platform] || 'Invalid link')}
                  {status === 'idle' && 'Optional'}
                </span>
              </label>
            );
          })}
        </div>
        {fieldErrors.social && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 4 }}>{fieldErrors.social}</p>}
      </div>
      <button type="button" onClick={prevStep}>Previous</button>
      <button
        type="submit"
        disabled={bio.trim().length < 100 || !profilePhoto || completedEntries.length < 3}
      >
        Next
      </button>
    </form>
  );
}
