// Root build — no Spring Boot here. Detection should walk into subprojects.
plugins {
    java
}

allprojects {
    repositories {
        mavenCentral()
    }
}
