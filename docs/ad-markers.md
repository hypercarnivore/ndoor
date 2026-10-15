# How Nextdoor marks ads

Observed 2026-10-10 on the desktop web app (nextdoor.com). Useful for ndoor's
filtering and for a future ad-blocking browser extension.

## In the GraphQL API

Main feed (`PersonalizedFeed` -> `me.personalizedFeed.feedItems[]`):

| Field                     | Organic post   | Ad              |
|---------------------------|----------------|-----------------|
| `feedItemType`            | `POST`         | `PROMO`         |
| `__typename`              | `FeedItemPost` | `FeedItemPromo` |
| `promo.__typename`        | -              | `Ad`            |
| `promo.promoType`         | -              | `NAMPLUS_AD`    |

Ads also carry `adOpportunityEvent`, `promo.adBid`, `promo.creative.sponsorName`
and `adsTrackingMetadata` (advertiser id, ad unit id, request id). In a sample
of 41 feed items, 11 (27%) were ads.

Other surfaces:

- Comment connections (`pagedComments.edgesV2[]`) have an `adOpportunityEvent`
  slot per edge. It was always null in samples, but this is where ads can be
  injected into comment threads.
- Search results (`searchPostFeed...edges[].node`) have an `adFormat` field.
  It was null for organic results. ndoor drops any result where it is set.
- Business and agency posts are not ads. They are organic posts whose
  `post.author.authorType` is `ENTITY_PAGES` or `CITY_AGENCY` (neighbors are
  `NEIGHBOR`).

## In the DOM

Every feed item is wrapped in a container that carries its type:

```html
<div id="feedItem_8476392992834947320" data-feed-item-type="PROMO">
  <div data-testid="dwell-tracker-feedItem:8476392992834947320">
    ... <div data-testid="feed-item-card"> ... "Sponsored" ...
```

Organic posts use `data-feed-item-type="POST"`, and their numeric id is the
legacy post id. Ad ids are much larger (19 digits). One CSS rule hides feed ads:

```css
div[data-feed-item-type="PROMO"] { display: none !important; }
```

Class names are hashed (`Styled__zpop7k`, `TextItem__bzs8zq1`) and change between
deploys. Don't target them; the `data-feed-item-type` attribute and `data-testid`
values are the stable hooks. The right-hand rail is loaded by `getRhrFeed` and
was not examined.
