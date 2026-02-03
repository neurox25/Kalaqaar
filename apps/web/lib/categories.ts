export type Category = {
    key: string;
    title: string;
    blurb: string;
    iconPath: string;
    instant?: boolean; // Phase-1 "priority confirmation" flag (wording: no instant booking)
    trending?: boolean; // Phase-1 trending badge
    note?: string; // Phase-1 special notes
};

// Phase-1 Artist Categories (Performers & Creative Talent)
export const CATEGORIES_PHASE1_ARTISTS: Category[] = [
    {
        key: 'dj',
        title: 'DJ',
        blurb: 'Wedding, Corporate & Club Events',
        iconPath: '/icons/dj.svg',
        instant: true,
        trending: true
    },
    {
        key: 'singer',
        title: 'Solo Singer',
        blurb: 'Acoustic, Bollywood & Indie Vocalists',
        iconPath: '/icons/mic.svg',
        instant: true
    },
    {
        key: 'anchor',
        title: 'Emcee / Host',
        blurb: 'Weddings, Sangeet & Corporate Hosting',
        iconPath: '/icons/mic-stand.svg',
        instant: true
    },
    {
        key: 'dance_group',
        title: 'Dance Group',
        blurb: 'Wedding entries, sangeet & performances',
        iconPath: '/icons/dance.svg',
        instant: true
    },
    {
        key: 'choreographer',
        title: 'Choreographer',
        blurb: 'Sangeet choreography & rehearsals',
        iconPath: '/icons/magic.svg',
        instant: true
    }
];

// Phase-1 Vendor Categories (Sound & Light Providers)
export const CATEGORIES_PHASE1_VENDORS: Category[] = [
    {
        key: 'sound',
        title: 'Sound (Full Gear + Techs)',
        blurb: 'Full sound setup + technicians included',
        iconPath: '/icons/drum.svg',
        instant: true
    },
    {
        key: 'light',
        title: 'Light (Full Gear + Techs)',
        blurb: 'Full lighting setup + technicians included',
        iconPath: '/icons/spark.svg',
        instant: true
    }
];

// Phase-1 Priority Confirmation Categories (All Categories for Website Display)
export const CATEGORIES_PHASE1_INSTANT: Category[] = [
    ...CATEGORIES_PHASE1_ARTISTS,
    ...CATEGORIES_PHASE1_VENDORS
];

// Phase-1 Discovery Only Categories (kept empty for Mumbai wedding-forward launch)
export const CATEGORIES_PHASE1_DISCOVERY: Category[] = [];

// Legacy categories for backward compatibility (will be removed in Phase-2)
export const CATEGORIES_PHASE1: Category[] = [
    ...CATEGORIES_PHASE1_INSTANT,
    ...CATEGORIES_PHASE1_DISCOVERY
];
