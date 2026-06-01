ARG AUR_PLATFORM=linux/amd64
FROM --platform=${AUR_PLATFORM} archlinux:base-devel

RUN printf '\nDisableSandbox\n' >> /etc/pacman.conf \
  && pacman -Syu --noconfirm --needed \
    alsa-lib \
    bun \
    ca-certificates \
    cairo \
    desktop-file-utils \
    dpkg \
    gdk-pixbuf2 \
    git \
    glib-networking \
    gtk3 \
    hicolor-icon-theme \
    libayatana-appindicator \
    libsoup3 \
    nodejs \
    openssl \
    pango \
    pkgconf \
    rustup \
    sudo \
    webkit2gtk-4.1 \
  && pacman -Scc --noconfirm

RUN useradd --create-home --shell /bin/bash builder \
  && printf 'builder ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/builder \
  && chmod 0440 /etc/sudoers.d/builder

COPY scripts/aur-build-all.sh /usr/local/bin/aur-build-all
RUN chmod 0755 /usr/local/bin/aur-build-all

USER builder
WORKDIR /home/builder

ENTRYPOINT ["/usr/local/bin/aur-build-all"]
