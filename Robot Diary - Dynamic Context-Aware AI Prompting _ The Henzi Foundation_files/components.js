// Component Loader - Loads header and footer from separate files
document.addEventListener('DOMContentLoaded', function() {
    // Get current page name for active link highlighting
    let currentPage = window.location.pathname.split('/').pop();
    if (!currentPage || currentPage === '' || currentPage === '/') {
        currentPage = 'index.html';
    }
    const pageName = currentPage.replace('.html', '') || 'index';
    
    // Check if we're using file:// protocol (local file system)
    const isFileProtocol = window.location.protocol === 'file:';
    
    if (isFileProtocol) {
        console.warn('⚠️ Components cannot load via file:// protocol. Please use a local web server.');
        console.warn('Run: ./serve.sh (or use a local server like Live Server in VS Code)');
        showFileProtocolWarning();
        return;
    }
    
    // All HTML files are in frontend/, components are in frontend/components/
    // Use absolute path to work correctly from any URL path (including 404 pages)
    // This ensures components load correctly even when 404 pages are served from subdirectories
    const componentsPath = '/components/';
    
    // Load header
    const headerPlaceholder = document.getElementById('header-placeholder');
    if (headerPlaceholder) {
        const headerPath = componentsPath + 'header.html';
        console.log('Loading header from:', headerPath);
        fetch(headerPath)
            .then(response => {
                console.log('Header response status:', response.status);
                if (!response.ok) {
                    throw new Error(`Failed to load header: ${response.status} ${response.statusText}`);
                }
                return response.text();
            })
            .then(html => {
                if (html && html.trim()) {
                    // Set placeholder height to match expected header height to prevent layout shift
                    headerPlaceholder.style.height = '80px';
                    headerPlaceholder.style.visibility = 'visible';
                    
                    // Use requestAnimationFrame to batch DOM operations and avoid forced reflow
                    requestAnimationFrame(() => {
                        headerPlaceholder.outerHTML = html;
                        // Set active link after header is loaded
                        requestAnimationFrame(() => {
                            setActiveLink(pageName);
                            initMobileMenu();
                            initDropdownMenu();
                        });
                    });
                } else {
                    throw new Error('Header HTML is empty');
                }
            })
            .catch(error => {
                console.error('Error loading header:', error);
                console.error('Attempted path:', headerPath);
                // Fallback: show error message
                headerPlaceholder.innerHTML = '<div style="color: red; padding: 20px; background: #ffe6e6; border: 2px solid red; margin: 20px;">Error loading navigation: ' + error.message + '. Please check that components/header.html exists and refresh the page.</div>';
            });
    } else {
        console.warn('Header placeholder not found');
    }
    
    // Load footer
    const footerPlaceholder = document.getElementById('footer-placeholder');
    if (footerPlaceholder) {
        const footerPath = componentsPath + 'footer.html';
        console.log('Loading footer from:', footerPath);
        fetch(footerPath)
            .then(response => {
                console.log('Footer response status:', response.status);
                if (!response.ok) {
                    throw new Error(`Failed to load footer: ${response.status} ${response.statusText}`);
                }
                return response.text();
            })
            .then(html => {
                if (html && html.trim()) {
                    // Set placeholder height to match expected footer height to prevent layout shift
                    footerPlaceholder.style.height = '200px';
                    footerPlaceholder.style.visibility = 'visible';
                    
                    // Use requestAnimationFrame to batch DOM operations and avoid forced reflow
                    requestAnimationFrame(() => {
                        footerPlaceholder.outerHTML = html;
                    });
                } else {
                    throw new Error('Footer HTML is empty');
                }
            })
            .catch(error => {
                console.error('Error loading footer:', error);
                console.error('Attempted path:', footerPath);
                // Fallback: show error message
                footerPlaceholder.innerHTML = '<div style="color: red; padding: 20px; background: #ffe6e6; border: 2px solid red; margin: 20px;">Error loading footer: ' + error.message + '. Please check that components/footer.html exists and refresh the page.</div>';
            });
    } else {
        console.warn('Footer placeholder not found');
    }
    
    // Set active link if header already exists (fallback)
    if (!headerPlaceholder) {
        setTimeout(() => {
            setActiveLink(pageName);
            initMobileMenu();
        }, 10);
    }
});

// Set active class on current page's nav link
function setActiveLink(pageName) {
    const navLinks = document.querySelectorAll('#nav-menu a[data-page]');
    navLinks.forEach(link => {
        const linkPage = link.getAttribute('data-page');
        if (linkPage === pageName) {
            link.classList.add('active');
            // Don't add 'active' to dropdown on desktop - it should only show on hover
            // The active class on the link itself is sufficient for styling
        } else {
            link.classList.remove('active');
        }
    });
}

// Initialize mobile menu functionality
function initMobileMenu() {
    const menuToggle = document.querySelector('.menu-toggle');
    const navMenu = document.getElementById('nav-menu');
    
    if (menuToggle && navMenu) {
        // Remove existing listeners by cloning
        const newToggle = menuToggle.cloneNode(true);
        menuToggle.parentNode.replaceChild(newToggle, menuToggle);
        
        newToggle.addEventListener('click', function() {
            navMenu.classList.toggle('active');
        });
        
        // Close menu when clicking on a link (but not dropdown toggle)
        const navLinks = navMenu.querySelectorAll('a:not(.dropdown-toggle)');
        navLinks.forEach(link => {
            link.addEventListener('click', function() {
                navMenu.classList.remove('active');
            });
        });
        
        // Close menu when clicking outside
        document.addEventListener('click', function(event) {
            const isClickInsideNav = navMenu.contains(event.target);
            const isClickOnToggle = newToggle.contains(event.target);
            const isClickOnDropdownToggle = event.target.closest('.dropdown-toggle');
            
            if (!isClickInsideNav && !isClickOnToggle && !isClickOnDropdownToggle && navMenu.classList.contains('active')) {
                navMenu.classList.remove('active');
            }
            });
    }
}

// Initialize dropdown menu functionality
function initDropdownMenu() {
    const dropdownToggle = document.querySelector('.dropdown-toggle');
    const navDropdown = document.querySelector('.nav-dropdown');
    
    if (dropdownToggle && navDropdown) {
        // Handle click on mobile/tablet
        dropdownToggle.addEventListener('click', function(e) {
            // Only prevent default on mobile (when menu is vertical)
            if (window.innerWidth <= 768) {
                e.preventDefault();
                e.stopPropagation(); // Prevent event from bubbling to mobile menu handler
                navDropdown.classList.toggle('active');
            }
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', function(event) {
            const isClickInsideDropdown = navDropdown.contains(event.target);
            const isClickOnDropdownToggle = event.target.closest('.dropdown-toggle');
            
            // Don't close if clicking on the toggle itself (handled above)
            if (!isClickInsideDropdown && !isClickOnDropdownToggle && navDropdown.classList.contains('active')) {
                navDropdown.classList.remove('active');
            }
        });
        
        // Close dropdown when clicking on a dropdown link
        const dropdownLinks = navDropdown.querySelectorAll('.dropdown-menu a');
        dropdownLinks.forEach(link => {
            link.addEventListener('click', function() {
                navDropdown.classList.remove('active');
                // Also close the mobile menu when a dropdown link is clicked
                const navMenu = document.getElementById('nav-menu');
                if (navMenu && window.innerWidth <= 768) {
                    navMenu.classList.remove('active');
                }
            });
        });
    }
}

// Show warning if using file:// protocol
function showFileProtocolWarning() {
    const headerPlaceholder = document.getElementById('header-placeholder');
    const footerPlaceholder = document.getElementById('footer-placeholder');
    
    const warningHTML = `
        <div style="background: #fff3cd; border: 2px solid #ffc107; padding: 20px; margin: 20px; border-radius: 5px;">
            <h3 style="color: #856404; margin-top: 0;">⚠️ Local Server Required</h3>
            <p style="color: #856404; margin-bottom: 10px;">
                Components cannot load when opening HTML files directly. Please use a local web server:
            </p>
            <ul style="color: #856404; margin-bottom: 10px;">
                <li><strong>Option 1:</strong> Run <code>./serve.sh</code> from the project root, then open <code>http://localhost:8000</code></li>
                <li><strong>Option 2:</strong> Use VS Code's Live Server extension</li>
                <li><strong>Option 3:</strong> Use any local web server (Python, Node.js, etc.)</li>
            </ul>
            <p style="color: #856404; margin: 0; font-size: 0.9em;">
                This is a browser security restriction - fetch() requires HTTP/HTTPS protocol.
            </p>
        </div>
    `;
    
    if (headerPlaceholder) {
        headerPlaceholder.innerHTML = warningHTML;
    }
    if (footerPlaceholder) {
        footerPlaceholder.innerHTML = '<div style="text-align: center; padding: 20px; color: #666;">Footer will load when using a web server.</div>';
    }
}

