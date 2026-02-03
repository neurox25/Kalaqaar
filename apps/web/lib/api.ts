import { httpsCallable } from "firebase/functions";
import { getFirebaseFunctions } from "./firebaseClient";
import { CATEGORIES_PHASE1 } from "./categories";
import { SUPPORTED_CITIES } from "./cities";
import { API_BASE_URL } from "./env";

const DEFAULT_FUNCTIONS_BASE = process.env.NEXT_PUBLIC_FUNCTIONS_BASE_URL || process.env.FUNCTIONS_BASE_URL || "https://asia-south1-kalaqaar-1cd70.cloudfunctions.net";

export type GenerateBioInput = {
    displayName?: string;
    category?: string;
    city?: string;
    languages?: string[];
    style?: string;
    tone?: string;
};

export async function generateArtistBio(options: GenerateBioInput): Promise<string[]> {
    // Test hook: if a test stub is installed on the window, use it so Playwright/tests
    // can exercise the UI without requiring a real Firebase Functions instance.
    if (typeof window !== 'undefined' && (window as any).__TEST_GENERATE_BIO) {
        try {
            const fn = (window as any).__TEST_GENERATE_BIO;
            const result = await fn(options);
            return Array.isArray(result) ? result : [];
        } catch (err: any) {
            throw new Error((err && err.message) || 'Test generate bio failed');
        }
    }

    const functions = getFirebaseFunctions();
    if (!functions) throw new Error("AI service is temporarily unavailable. Please try again.");
    const callable = httpsCallable(functions, "generateArtistBio");
    const payload = {
        displayName: options.displayName || undefined,
        category: options.category || undefined,
        city: options.city || undefined,
        languages: Array.isArray(options.languages) ? options.languages.slice(0, 5) : undefined,
        style: options.style || undefined,
        tone: options.tone || "warm",
    };
    try {
        const response = await callable(payload as any);
        const data = response.data as { suggestions?: string[] };
        const list = Array.isArray(data?.suggestions) ? data.suggestions : [];
        // Clamp suggestions client-side as a safety net for UI validation (50–300 chars)
        const clamp = (s: string) => s.length > 300 ? s.slice(0, 300).replace(/[\s,]+[^\s,]*$/, '…') : s;
        return list
            .map((s) => (typeof s === 'string' ? s.trim() : ''))
            .filter(Boolean)
            .map(clamp)
            .filter((s) => s.length >= 50);
    } catch (error: any) {
        const friendlyMessage =
            error?.details ||
            error?.message ||
            "We couldn’t generate a bio right now. Please try again in a bit.";
        const wrapped = new Error(friendlyMessage);
        (wrapped as any).code = error?.code ?? null;
        throw wrapped;
    }
}

export type ImageQualityResult = {
    score: number;
    feedback: string;
    issues: string[];
    description?: string;
    tags?: string[];
};

export async function analyzePortfolioImage(imageUrl: string, options?: { comprehensive?: boolean, artistContext?: any }): Promise<ImageQualityResult> {
    const functions = getFirebaseFunctions();
    if (!functions) {
        // Return a neutral result if functions aren't available
        return { score: 75, feedback: "Analysis temporarily unavailable", issues: [] };
    }
    
    const callable = httpsCallable(functions, "analyzeImageQuality");
    try {
        const response = await callable({
            imageUrl,
            comprehensive: options?.comprehensive,
            artistContext: options?.artistContext
        });
        return response.data as ImageQualityResult;
    } catch (error: any) {
        console.warn("Image analysis failed", error);
        // Return a neutral score so UI doesn't break
        return { 
            score: 75, 
            feedback: "Image analysis temporarily unavailable - will be processed later", 
            issues: [] 
        };
    }
}

export function getFunctionsBaseUrl(): string {
    return DEFAULT_FUNCTIONS_BASE;
}

export function resolveCategoryTitle(categoryKey: string): string | undefined {
    const matched = CATEGORIES_PHASE1.find((c) => c.key === categoryKey);
    return matched?.title;
}

export function resolveCityName(cityKey: string): string | undefined {
    const city = SUPPORTED_CITIES.find((c) => c.key === cityKey);
    return city?.title;
}

export async function fetchArtistsByCategoryCity(categoryKey: string, cityKey: string, options?: { revalidate?: number }): Promise<any[]> {
    const categoryTitle = resolveCategoryTitle(categoryKey) || categoryKey;
    const cityTitle = resolveCityName(cityKey) || cityKey;
    const base = getFunctionsBaseUrl();
    const url = new URL(`${base.replace(/\/$/, "")}/getArtistsByCategoryCity`);
    url.searchParams.set("category", categoryTitle);
    url.searchParams.set("city", cityTitle);
    url.searchParams.set("categoryKey", categoryKey);
    url.searchParams.set("cityKey", cityKey);
    const fetchOptions: RequestInit & { next?: { revalidate?: number } } = {
        headers: { "Content-Type": "application/json" },
    };
    if (typeof window === "undefined" && options?.revalidate !== undefined) {
        fetchOptions.next = { revalidate: options.revalidate };
    }
    const resp = await fetch(url.toString(), fetchOptions);
    if (!resp.ok) {
        throw new Error(`Failed to load artists for ${categoryKey} in ${cityKey}`);
    }
    const data = await resp.json();
    if (!data?.ok || !Array.isArray(data?.artists)) return [];
    return data.artists;
}

export async function fetchArtistPublicProfile(referralId: string, options?: { revalidate?: number }): Promise<any | null> {
    if (!referralId) return null;
    const variants = Array.from(new Set([referralId, referralId.toUpperCase(), referralId.toLowerCase()]));

    // Prefer same-origin Hosting rewrite to avoid CORS
    const makeUrl = () => {
        try {
            if (typeof window !== 'undefined' && window.location && window.location.origin) {
                return new URL(`${window.location.origin}/api/profile`);
            }
        } catch (_) { /* fall through */ }
        return new URL(`${getFunctionsBaseUrl().replace(/\/$/, '')}/getArtistPublicProfile`);
    };

    const fetchOptions: RequestInit & { next?: { revalidate?: number } } = {};
    if (typeof window === "undefined" && options?.revalidate !== undefined) {
        fetchOptions.next = { revalidate: options.revalidate };
    }

    for (const candidate of variants) {
        const url = makeUrl();
        url.searchParams.set("id", candidate);
        const resp = await fetch(url.toString(), fetchOptions);
        if (resp.status === 404) continue;
        if (!resp.ok) continue;
        const data = await resp.json();
        if (!data?.ok) continue;
        return data.artist ?? null;
    }
    return null;
}

export async function fetchArtistPrivateProfile(referralId: string, bookingId: string, idToken: string): Promise<any | null> {
    if (!referralId || !bookingId || !idToken) return null;
    let base: string;
    try {
        if (typeof window !== 'undefined' && window.location && window.location.origin) {
            base = `${window.location.origin}/api`;
        } else {
            base = getFunctionsBaseUrl().replace(/\/$/, '');
        }
    } catch (_e) {
        base = getFunctionsBaseUrl().replace(/\/$/, '');
    }
    const url = new URL(`${base}/profile/private`);
    url.searchParams.set('id', referralId);
    url.searchParams.set('booking', bookingId);
    const resp = await fetch(url.toString(), {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
            // Explicitly prevent any intermediate caches
            'Cache-Control': 'no-store',
        },
    } as RequestInit);
    if (resp.status === 403 || resp.status === 404) return null;
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    if (!data?.ok) return null;
    return data.artist ?? null;
}

export function slugifyCategory(categoryKey: string): string {
    const title = resolveCategoryTitle(categoryKey) || categoryKey;
    return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function buildCategoryCitySlug(categoryKey: string, cityKey: string): string {
    const categorySlug = slugifyCategory(categoryKey);
    return `${categorySlug}-in-${cityKey}`;
}

export function parseCategoryCitySlug(slug: string): { categoryKey?: string; cityKey?: string } {
    const [categoryPart, cityPart] = slug.split("-in-");
    if (!categoryPart || !cityPart) return {};
    const normalizedCity = cityPart.toLowerCase();
    const city = SUPPORTED_CITIES.find((c) => c.key === normalizedCity);
    let categoryKey: string | undefined;
    const normalizedCategory = categoryPart.toLowerCase();
    const directMatch = CATEGORIES_PHASE1.find((c) => c.key === normalizedCategory);
    if (directMatch) {
        categoryKey = directMatch.key;
    } else {
        // Match by slugified title fragment
        for (const cat of CATEGORIES_PHASE1) {
            const slug = slugifyCategory(cat.key);
            if (slug === normalizedCategory || slug.includes(normalizedCategory) || normalizedCategory.includes(slug)) {
                categoryKey = cat.key;
                break;
            }
        }
    }
    return {
        categoryKey,
        cityKey: city?.key,
    };
}

export type ArtistInstantBookingSummary = {
    enabled: boolean;
    hourlyRate?: number | null;
    minAdvanceMinutes?: number | null;
    maxAdvanceMinutes?: number | null;
    minDurationMinutes?: number | null;
    maxDurationMinutes?: number | null;
    allowedEventTypes?: string[];
    penaltyStatus?: string | null;
};

export type ArtistAvailabilitySummary = {
    hasAvailability: boolean;
    nextAvailableAt?: string | null;
    nextAvailableTimestamp?: number | null;
};

export type ClientBookingSummary = {
    id: string;
    status?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    eventDate?: string | null;
    city?: string | null;
    cityKey?: string | null;
    categoryKey?: string | null;
    category?: string | null;
    budget?: number | null;
    preferredArtists?: string[] | null;
    paymentStatus?: string | null;
    paymentLink?: string | null;
    paymentAmount?: number | null;
    paymentOrderId?: string | null;
    chatId?: string | null;
};

export type ArtistSearchResult = {
    referralId: string;
    profilePath: string;
    city?: string | null;
    cityKey?: string | null;
    primaryCategory?: string | null;
    categoryKeys?: string[];
    categories?: string[];  // From search API
    priceStart?: number | null;
    tags?: string[];
    heroPhoto?: string | null;
    rating?: number | null;
    reviewCount?: number | null;
    artistUid?: string | null;
    verified?: boolean;  // From search API
    instantBooking?: ArtistInstantBookingSummary | null;
    availability?: ArtistAvailabilitySummary | null;
    // NOTE: name and bio intentionally removed for privacy
};

type ArtistSearchResponse = {
    ok: boolean;
    results: ArtistSearchResult[];
    count: number;
};

function getSearchBase(): string {
    // Always prefer runtime same-origin /api to avoid CORS and CSP
    try {
        if (typeof window !== 'undefined' && window.location && window.location.origin) {
            return `${window.location.origin}/api`;
        }
    } catch (_) { /* ignore */ }
    return (API_BASE_URL || '').replace(/\/$/, '');
}

export async function searchArtists(params: {
    query?: string;
    cityKey?: string;
    categoryKey?: string;
    limit?: number;
}): Promise<ArtistSearchResult[]> {
    const base = getSearchBase();
    if (!base) throw new Error("API base URL not configured");
    const url = new URL(`${base}/search/artists`);
    // Provide a default search term if query is empty or undefined
    const searchQuery = params.query?.trim() || 'artist';
    url.searchParams.set("query", searchQuery);
    if (params.cityKey) {
        url.searchParams.set("cityKey", params.cityKey);
        url.searchParams.set("city", params.cityKey); // for Functions wrapper compatibility
    }
    if (params.categoryKey) {
        url.searchParams.set("categoryKey", params.categoryKey);
        url.searchParams.set("category", params.categoryKey); // for Functions wrapper compatibility
    }
    if (params.limit) url.searchParams.set("limit", String(params.limit));

    const resp = await fetch(url.toString(), {
        method: "GET",
        headers: { "Content-Type": "application/json" },
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || "Failed to search artists");
    }
    const data = await resp.json();
    // Map legacy/alternative schemas (Functions /api/search wrapper) if encountered
    if (Array.isArray(data?.results) && data.results.length && data.results[0]?.artist) {
        const mapped = data.results.map((r: any) => ({
            referralId: r.artist?.referralId || r.id || '',
            profilePath: r.artist?.profilePath || (r.id ? `/a/${String(r.id).toLowerCase()}` : ''),
            city: r.artist?.city || null,
            primaryCategory: Array.isArray(r.artist?.categories) ? r.artist.categories[0] : null,
            categories: r.artist?.categories || [],
            heroPhoto: r.artist?.heroPhoto || null,
            priceStart: r.artist?.priceStart || null,
            verified: r.artist?.verified || false,
            tags: [],
            instantBooking: null,
            availability: null,
        }));
        return mapped;
    }
    const typed: ArtistSearchResponse = data;
    return Array.isArray(typed.results) ? typed.results : [];
}

export async function fetchClientBookings(idToken: string, limit?: number): Promise<ClientBookingSummary[]> {
    const base = (API_BASE_URL || "").replace(/\/$/, "");
    const url = new URL(`${base}/client/bookings`);
    if (limit) url.searchParams.set("limit", String(limit));
    const resp = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
        },
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || "Failed to load bookings");
    }
    const data = await resp.json();
    if (!data?.ok || !Array.isArray(data?.bookings)) return [];
    return data.bookings as ClientBookingSummary[];
}
