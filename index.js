import puppeteer from 'puppeteer';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import fs from 'fs';
import { Buffer } from 'buffer';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function hideFixedElements(page) {
  await page.evaluate(() => {
    return new Promise((resolve) => {
      // Hide common fixed elements by their CSS properties
      const hideFixedElements = () => {
        const elements = document.querySelectorAll('*');
        elements.forEach(el => {
          const style = window.getComputedStyle(el);
          if (style.position === 'fixed' || style.position === 'sticky') {
            el.style.visibility = 'hidden'; // Use visibility instead of display to maintain layout
          }
        });
      };

      // Hide specific elements that might be headers or navigation bars
      const commonSelectors = [
        'header',
        'nav',
        '[class*="header"]',
        '[class*="navigation"]',
        '[class*="navbar"]',
        '[class*="nav-bar"]',
        '[class*="fixed"]',
        '[class*="sticky"]'
      ];

      commonSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => {
          el.style.visibility = 'hidden';
        });
      });

      // Run the fixed elements check
      hideFixedElements();
      
      // Give a short delay for any animations to complete
      setTimeout(resolve, 1000);
    });
  });
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      let retries = 0;
      const maxRetries = 50; // Prevent infinite scrolling
      let lastHeight = 0;
      let unchangedCount = 0;
      
      const timer = setInterval(() => {
        const scrollHeight = document.documentElement.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        // Check if the height hasn't changed
        if (lastHeight === scrollHeight) {
          unchangedCount++;
          // If height hasn't changed for 5 consecutive checks, assume we've reached the bottom
          if (unchangedCount >= 5) {
            clearInterval(timer);
            resolve();
          }
        } else {
          unchangedCount = 0;
          lastHeight = scrollHeight;
        }

        // Backup check to prevent infinite scrolling
        if (retries >= maxRetries) {
          clearInterval(timer);
          resolve();
        }
        retries++;
      }, 200);
    });
  });
}

async function waitForVehicleContent(page) {
  try {
    // Wait for common vehicle listing selectors
    await page.waitForFunction(() => {
      const selectors = [
        // Common vehicle listing indicators
        '[class*="vehicle"]',
        '[class*="inventory"]',
        '[class*="listing"]',
        '[class*="product"]',
        // Specific content indicators
        'img[src*="bus"]',
        'img[src*="vehicle"]',
        '[class*="price"]',
        '[class*="description"]'
      ];
      
      return selectors.some(selector => 
        document.querySelectorAll(selector).length > 0
      );
    }, { timeout: 10000 });
  } catch (error) {
    console.log('Timeout waiting for vehicle content, continuing anyway...');
  }
}

async function getVehicleListings(page) {
  return await page.evaluate(() => {
    const selectors = [
      '.vehicle-item', '.inventory-item', '.product-item',
      '[class*="vehicle"]', '[class*="inventory"]', '[class*="listing"]',
      '.col-sm-6', '.col-md-6', // Common grid layouts
      '[class*="product-grid"]'
    ];

    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      const validElements = elements.filter(el => {
        const hasImage = el.querySelector('img') !== null;
        const hasPrice = el.textContent.toLowerCase().includes('price') || 
                        el.textContent.toLowerCase().includes('contact');
        const hasYear = /20\d{2}/.test(el.textContent);
        return hasImage && (hasPrice || hasYear) && el.offsetHeight > 0;
      });

      if (validElements.length > 0) {
        return validElements.map(el => {
          const rect = el.getBoundingClientRect();
          return {
            top: el.offsetTop,
            height: rect.height,
            width: rect.width
          };
        });
      }
    }
    return [];
  });
}

async function captureListingSection(page, listings, startIndex, endIndex) {
  if (startIndex >= listings.length) return null;

  const section = listings.slice(startIndex, endIndex);
  if (!section.length) return null;

  const startY = section[0].top;
  const lastItem = section[section.length - 1];
  const sectionHeight = (lastItem.top + lastItem.height) - startY;

  // Scroll to the section
  await page.evaluate((y) => window.scrollTo(0, y), startY);
  await new Promise(resolve => setTimeout(resolve, 500));

  // Capture the section
  const screenshot = await page.screenshot({
    clip: {
      x: 0,
      y: startY,
      width: page.viewport().width,
      height: sectionHeight,
    },
    encoding: 'base64',
    optimizeForSpeed: true
  });

  return {
    screenshot,
    itemCount: section.length,
    startIndex,
    endIndex: Math.min(endIndex, listings.length)
  };
}

async function analyzeImageWithGPT4Vision(base64Image, sectionInfo) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this section of vehicle listings (items ${sectionInfo.startIndex + 1} to ${sectionInfo.endIndex} of the page) and extract detailed information. Structure the data as follows:

{
  "vehicles": [
    {
      "title": "full vehicle name including manufacturer and model",
      "year": "vehicle year",
      "price": "exact price text as shown (include 'Call for Price', 'Contact Us', etc. if shown)",
      "description": "any descriptive text about the vehicle's condition, features, or history",
      "specifications": {
        "make": "manufacturer name",
        "model": "specific model name/number",
        "chassis": "chassis type if shown",
        "condition": "new/pre-owned/used",
        "stock_number": "stock or reference number",
        "mileage": "current mileage with exact format as shown",
        "passenger_capacity": "number of passengers",
        "engine": "engine specifications if shown",
        "transmission": "transmission type if shown",
        "fuel_type": "gas/diesel/other",
        "exterior_color": "vehicle color",
        "location": "listed location",
        "dimensions": {
          "length": "vehicle length if shown",
          "width": "vehicle width if shown",
          "height": "vehicle height if shown"
        },
        "features": []
      }
    }
  ]
}`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ]
        }
      ],
      max_tokens: 4096
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error analyzing image section:', error);
    return null;
  }
}

async function mergeResults(results) {
  const allVehicles = results.flatMap(result => {
    try {
      if (!result) return [];
      
      // Clean up markdown formatting if present
      let jsonStr = result;
      if (typeof result === 'string') {
        // Remove markdown code blocks if present
        jsonStr = result.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        // Remove any leading/trailing whitespace
        jsonStr = jsonStr.trim();
      }

      const parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
      return parsed.vehicles || [];
    } catch (error) {
      console.error('Error parsing result:', error);
      console.error('Raw result:', result);
      return [];
    }
  });

  // Remove duplicates based on stock number and title
  const uniqueVehicles = Array.from(new Map(
    allVehicles.map(vehicle => [
      vehicle.specifications.stock_number + '-' + vehicle.title,
      vehicle
    ])
  ).values());

  return {
    vehicles: uniqueVehicles
  };
}

async function main() {
  try {
    const browser = await puppeteer.launch({ 
      headless: "new",
      defaultViewport: {
        width: 1920,
        height: 1920
      }
    });
    const page = await browser.newPage();
    
    // Navigate to the target website
    await page.goto('https://www.hudsonbussales.com/PreOwnedBusesForSale', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    // Wait for vehicle content to load
    console.log('Waiting for vehicle content to load...');
    await waitForVehicleContent(page);

    // Hide fixed elements
    console.log('Hiding fixed elements...');
    await hideFixedElements(page);

    // Scroll to load all content
    console.log('Scrolling to load all content...');
    await autoScroll(page);
    
    // Get all vehicle listings
    const listings = await getVehicleListings(page);
    console.log(`Found ${listings.length} vehicle listings`);

    if (listings.length === 0) {
      throw new Error('No vehicle listings found');
    }

    // Process listings in sections
    const itemsPerSection = 4; // Process 4 items at a time
    const results = [];
    
    for (let i = 0; i < listings.length; i += itemsPerSection) {
      console.log(`Processing section ${Math.floor(i / itemsPerSection) + 1}...`);
      
      const section = await captureListingSection(
        page, 
        listings, 
        i, 
        i + itemsPerSection
      );

      if (section) {
        // Save section screenshot for debugging
        fs.writeFileSync(
          `screenshot_section_${Math.floor(i / itemsPerSection) + 1}.jpg`,
          Buffer.from(section.screenshot, 'base64')
        );

        // Analyze section
        console.log(`Analyzing section ${Math.floor(i / itemsPerSection) + 1}...`);
        const analysis = await analyzeImageWithGPT4Vision(section.screenshot, {
          startIndex: section.startIndex,
          endIndex: section.endIndex
        });

        if (analysis) {
          results.push(analysis);
        }

        // Wait between API calls to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Merge all results
    console.log('Merging results...');
    const mergedData = await mergeResults(results);
    
    // Save the final merged data
    fs.writeFileSync('extracted_data.json', JSON.stringify(mergedData, null, 2));
    console.log('Data extraction complete. Results saved to extracted_data.json');

    await browser.close();
  } catch (error) {
    console.error('Error during scraping:', error);
  }
}

main();